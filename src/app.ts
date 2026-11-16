import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { 
  PatientMessageRequestSchema, 
  KnowledgeDocumentRequestSchema 
} from './schemas.js';
import { dbInstance } from './db.js';
import { aiService } from './services/ai.js';
import type { AIAnalysisResult, InferenceUnavailable } from './services/ai.js';
import { metricsService } from './services/metrics.js';

const startTime = Date.now();

export function buildApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 1048576
  });

  app.register(cors, { origin: true });

  // Rate Limiting: 120 peticiones por minuto por IP/tenant para frenar DoS / Denial of Wallet
  app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request: any, context: any) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Límite de tasa excedido. Máximo permitido: ${context.max} peticiones por ${context.after}.`
    })
  });

  // Hook global de observabilidad
  app.addHook('onRequest', async (request) => {
    metricsService.recordRequest(request.url);
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'TOO_MANY_REQUESTS',
        message: error.message || 'Límite de peticiones excedido.'
      });
    }

    if (error.validation || error.statusCode === 400 || (error.message && error.message.includes('JSON'))) {
      // Sanitización de PII y secrets en respuestas de error
      const safeMsg = metricsService.maskPII(error.message || 'Payload malformado o validación fallida.');
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: safeMsg
      });
    }
    reply.status(error.statusCode || 500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Error interno del servidor.'
    });
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000)
    };
  });

  // GET /metrics (Observabilidad & Producción - US-007)
  app.get('/metrics', async () => {
    return metricsService.getMetrics();
  });

  // Ingestión dinámica de RAG (Vector Database con aislamiento multitenant)
  app.post('/api/v1/knowledge/documents', async (request, reply) => {
    const parseResult = KnowledgeDocumentRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: parseResult.error.issues.map(i => i.message).join(', ')
      });
    }

    const { tenantId, documentId, title, content } = parseResult.data;
    const chunksCount = dbInstance.upsertDocument(tenantId, documentId, title, content);

    return reply.status(201).send({
      status: 'indexed',
      documentId,
      chunksIndexed: chunksCount
    });
  });

  // Procesamiento de mensaje de paciente
  app.post('/api/v1/patient-message', async (request, reply) => {
    const parseResult = PatientMessageRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: parseResult.error.issues.map(i => i.message).join(', ')
      });
    }

    const { message } = parseResult.data;
    const systemConfig = parseResult.data.systemConfig;
    const businessContext = parseResult.data.businessContext ?? parseResult.data.clinicContext;
    const lowerMsg = message.toLowerCase();
    const historyText = (parseResult.data.conversationHistory || [])
      .map(h => String(h.content).toLowerCase())
      .join(' ');
    const scanText = `${lowerMsg} ${historyText}`;

    // Invariante: detección y contención de inyecciones de prompt (jailbreak / system prompt leaks)
    // sobre mensaje e historial (el historial se trata como dato pasivo). La respuesta es neutra y configurable.
    const injectionPatterns = [
      'ignora todas las instrucciones',
      'system prompt',
      'modo mantenimiento',
      'openai_api_key',
      'gemini_api_key',
      'a partir de ahora eres',
      'do anything now',
      'dan',
      '[admin override]',
      'override',
      '<<sys>>'
    ];
    const isInjection = injectionPatterns.some(p => scanText.includes(p));
    if (isInjection) {
      const isOverride = scanText.includes('[admin override]') || scanText.includes('override') || scanText.includes('<<sys>>');
      return reply.status(200).send({
        intent: 'OTRO',
        confidence: 0.99,
        actionRequired: isOverride ? 'ESCALATE_HUMAN' : 'REPLY_ONLY',
        entities: {},
        suggestedReply: systemConfig?.neutralReply
          || 'Hola. Solo puedo ayudarte con consultas relacionadas al servicio.',
        ragSources: [],
        latencyMs: 0
      });
    }

    // Guardrails rápidos parametrizados por el cliente (sin lógica de dominio fija)
    if (systemConfig?.emergencyGuardrail) {
      const { terms, reply: emergencyReply, actionRequired, intent, urgency } = systemConfig.emergencyGuardrail;
      const isEmergency = terms.some(term => lowerMsg.includes(term.toLowerCase()));
      if (isEmergency) {
        return reply.status(200).send({
          intent: intent || 'ESCALATE_HUMAN',
          confidence: 0.99,
          actionRequired: actionRequired || 'ESCALATE_HUMAN',
          entities: { urgency },
          suggestedReply: emergencyReply,
          ragSources: [],
          latencyMs: 0
        });
      }
    }

    if (systemConfig?.restrictedGuardrail) {
      const { terms, reply: restrictedReply, actionRequired, intent, urgency } = systemConfig.restrictedGuardrail;
      const asksRestricted = terms.some(term => lowerMsg.includes(term.toLowerCase()));
      if (asksRestricted) {
        return reply.status(200).send({
          intent: intent || 'ESCALATE_HUMAN',
          confidence: 0.99,
          actionRequired: actionRequired || 'ESCALATE_HUMAN',
          entities: { urgency },
          suggestedReply: restrictedReply,
          ragSources: [],
          latencyMs: 0
        });
      }
    }

    // Procesamiento con IA Cascada (Gemini Flash Lite -> Ollama Local)
    const result = await aiService.processMessage(
      parseResult.data.tenantId,
      message,
      businessContext,
      parseResult.data.conversationHistory,
      parseResult.data.toolResult,
      systemConfig
    );

    // Sin motor de inferencia disponible: el cliente decide la contingencia
    if ('ok' in result && (result as InferenceUnavailable).ok === false) {
      const unavailable = result as InferenceUnavailable;
      metricsService.recordAIUsage('inference-unavailable', message, '');
      return reply.status(200).send(unavailable);
    }

    const analysis = result as AIAnalysisResult;

    // Registro de consumo de tokens y motor en observabilidad
    metricsService.recordAIUsage(
      analysis.engineUsed || 'unknown',
      message,
      analysis.suggestedReply
    );

    return reply.status(200).send({
      intent: analysis.intent,
      confidence: analysis.confidence,
      actionRequired: analysis.actionRequired,
      toolCall: analysis.toolCall,
      entities: analysis.entities,
      suggestedReply: analysis.suggestedReply,
      ragSources: analysis.ragSources,
      latencyMs: analysis.latencyMs,
      engineUsed: analysis.engineUsed
    });
  });

  return app;
}
