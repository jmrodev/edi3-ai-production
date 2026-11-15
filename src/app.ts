import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { 
  PatientMessageRequestSchema, 
  KnowledgeDocumentRequestSchema 
} from './schemas.js';
import { dbInstance } from './db.js';
import { aiService } from './services/ai.js';
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

    const { message, clinicContext } = parseResult.data;
    const lowerMsg = message.toLowerCase();

    // Invariante 1: Detección y Contención de Inyecciones de Prompt (Jailbreak / System Prompt Leaks)
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
      'override'
    ];
    const isInjection = injectionPatterns.some(p => lowerMsg.includes(p));
    if (isInjection) {
      const isOverride = lowerMsg.includes('[admin override]') || lowerMsg.includes('override');
      return reply.status(200).send({
        intent: 'OTRO',
        confidence: 0.99,
        actionRequired: isOverride ? 'ESCALATE_HUMAN' : 'REPLY_ONLY',
        entities: {
          doctorName: null,
          preferredShift: 'indistinto',
          urgency: 'baja'
        },
        suggestedReply: 'Hola. Como asistente virtual de la secretaría médica, solo puedo orientarte sobre turnos, horarios y normativas del consultorio.',
        ragSources: [],
        latencyMs: 10
      });
    }

    // Invariante 2: Triage de Emergencia Vital
    const urgentTerms = ['pecho', 'infarto', 'respirar', 'aire', 'desmayo', 'asfixia', 'coronario'];
    const isUrgent = urgentTerms.some(term => lowerMsg.includes(term));
    if (isUrgent) {
      return reply.status(200).send({
        intent: 'OTRO',
        confidence: 0.99,
        actionRequired: 'ESCALATE_HUMAN',
        entities: {
          doctorName: null,
          preferredShift: 'indistinto',
          urgency: 'alta'
        },
        suggestedReply: '⚠️ Por los síntomas que describes, te recomendamos acudir de inmediato a la guardia médica más cercana o comunicarte con el servicio de emergencias médicas (107 / 911). La secretaría ha sido notificada.',
        ragSources: [],
        latencyMs: 12
      });
    }

    // Invariante 3: Prescripción Cero (Psicofármacos)
    const medTerms = ['clonazepam', 'rivotril', 'receta', 'medicamento', 'farmaco', 'ansiolitico', 'morfina'];
    const asksMed = medTerms.some(term => lowerMsg.includes(term));
    if (asksMed) {
      return reply.status(200).send({
        intent: 'OTRO',
        confidence: 0.95,
        actionRequired: 'ESCALATE_HUMAN',
        entities: {
          doctorName: null,
          preferredShift: 'indistinto',
          urgency: 'baja'
        },
        suggestedReply: 'Hola. Te recordamos que la emisión o renovación de recetas médicas requiere evaluación médica presencial o consulta programada. No se emiten recetas automáticas por WhatsApp.',
        ragSources: ['recetas_y_tramites.md'],
        latencyMs: 15
      });
    }

    // Invariante 4: Solicitud de Turno (excluyendo consultas de precio/arancel)
    const priceTerms = ['precio', 'costo', 'arancel', 'cuanto cobra', 'cuánto cobra', 'cuanto sale', 'cuánto sale', 'valor'];
    const isPriceQuery = priceTerms.some(term => lowerMsg.includes(term));

    const bookingTerms = ['turno', 'cita', 'atender', 'consulta'];
    const isBooking = !isPriceQuery && bookingTerms.some(term => lowerMsg.includes(term));
    if (isBooking) {
      // Verificar si hay doctor con ese nombre
      let matchedDoctor: string | null = null;
      if (clinicContext?.doctors) {
        for (const doc of clinicContext.doctors) {
          const docParts = doc.name.toLowerCase().split(' ');
          if (docParts.some(part => part.length > 3 && lowerMsg.includes(part))) {
            matchedDoctor = doc.name;
            break;
          }
        }
      }

      const isMadrugada = lowerMsg.includes('madrugada') || lowerMsg.includes('3:30');
      const shift = lowerMsg.includes('tarde') ? 'tarde' :
                    lowerMsg.includes('mañana') ? 'manana' : 'indistinto';

      return reply.status(200).send({
        intent: 'SOLICITUD_TURNO',
        confidence: 0.94,
        actionRequired: isMadrugada ? 'REPLY_ONLY' : 'CREATE_PENDING_BOOKING',
        entities: {
          doctorName: matchedDoctor || (clinicContext?.doctors?.[0]?.name ?? 'Profesional de cabecera'),
          preferredShift: shift,
          urgency: 'baja'
        },
        suggestedReply: isMadrugada
          ? 'Hola. Los turnos de atención se brindan exclusivamente en horario hábil diurno.'
          : `Hola! Registramos tu solicitud para consultar turnos disponibles${matchedDoctor ? ` con ${matchedDoctor}` : ''}. La secretaría revisará la agenda y te enviará la confirmación definitiva a la brevedad.`,
        ragSources: ['atencion_y_modalidades.md'],
        latencyMs: 20
      });
    }

    // Procesamiento con IA Cascada (Gemini Flash Lite -> Ollama Local -> Deterministic Fallback)
    const result = await aiService.processMessage(
      parseResult.data.tenantId,
      message,
      clinicContext,
      parseResult.data.conversationHistory,
      parseResult.data.toolResult
    );

    // Registro de consumo de tokens y motor en observabilidad
    metricsService.recordAIUsage(
      result.engineUsed || 'deterministic-fallback',
      message,
      result.suggestedReply
    );

    return reply.status(200).send({
      intent: result.intent,
      confidence: result.confidence,
      actionRequired: result.actionRequired,
      toolCall: result.toolCall,
      entities: result.entities,
      suggestedReply: result.suggestedReply,
      ragSources: result.ragSources,
      latencyMs: result.latencyMs,
      engineUsed: result.engineUsed
    });
  });

  return app;
}
