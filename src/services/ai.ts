import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { dbInstance } from '../db.js';
import type { SystemConfig } from '../schemas.js';

export interface AIAnalysisResult {
  intent: string;
  confidence: number;
  actionRequired: 'REPLY_ONLY' | 'CREATE_PENDING_BOOKING' | 'ESCALATE_HUMAN' | 'CALL_TOOL';
  toolCall?: {
    tool: string;
    params?: Record<string, any>;
  };
  entities: Record<string, any>;
  suggestedReply: string;
  ragSources: string[];
  latencyMs: number;
  engineUsed?: string;
}

export interface InferenceUnavailable {
  ok: false;
  error: 'INFERENCE_UNAVAILABLE';
  latencyMs: number;
}

export type AIProcessResult = AIAnalysisResult | InferenceUnavailable;

/** Validación estricta de la salida del LLM (untrusted input). */
const AIOutputSchema = z.object({
  intent: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  actionRequired: z.enum(['REPLY_ONLY', 'CREATE_PENDING_BOOKING', 'ESCALATE_HUMAN', 'CALL_TOOL']),
  toolCall: z.object({
    tool: z.string().min(1).max(100),
    params: z.record(z.string(), z.any()).optional()
  }).optional(),
  entities: z.record(z.string(), z.any()).optional(),
  suggestedReply: z.string().min(1).max(4000),
  ragSources: z.array(z.string()).optional()
});

/**
 * Construye la instrucción de sistema a partir de la configuración del cliente.
 * No contiene ninguna regla, tool ni entidad de dominio fija.
 */
function buildSystemInstruction(systemConfig?: SystemConfig): string {
  const base = systemConfig?.systemPrompt
    || systemConfig?.systemRole
    || 'Eres un asistente virtual oficial para atención al cliente.';

  const intents = systemConfig?.allowedIntents && systemConfig.allowedIntents.length > 0
    ? systemConfig.allowedIntents.map(i => `"${i}"`).join(' | ')
    : 'string';

  const rules = (systemConfig?.operationalRules || [])
    .map((rule, index) => `${index + 1}. ${rule}`)
    .join('\n');

  const tools = systemConfig?.availableTools || [];
  const toolList = tools.length > 0
    ? tools.map(t => `- "${t.name}": ${t.description}${t.params && t.params.length > 0 ? ` (params: ${t.params.join(', ')})` : ''}`).join('\n')
    : '';
  const toolEnum = tools.length > 0 ? tools.map(t => `"${t.name}"`).join(' | ') : 'string';

  return `${base}
Tu función es clasificar la intención del usuario, extraer entidades y sugerir una respuesta empática, profesional y precisa.
${rules ? `\nREGLAS DE OPERACIÓN:\n${rules}\n` : ''}${toolList ? `\nHERRAMIENTAS DISPONIBLES (solo puedes solicitar estas):\n${toolList}\n\nSi necesitas datos que provee una herramienta, responde con "actionRequired": "CALL_TOOL" y "toolCall": { "tool": <nombre>, "params": { ... } }.\nSi ya tienes el resultado de la herramienta en <resultado_herramienta>, NO vuelvas a pedirla: responde al usuario con esos datos.\n` : ''}
Debes responder ÚNICAMENTE un objeto JSON válido con este esquema exacto:
{
  "intent": ${intents},
  "confidence": 0.0 a 1.0,
  "actionRequired": "REPLY_ONLY" | "CREATE_PENDING_BOOKING" | "ESCALATE_HUMAN" | "CALL_TOOL",
  "toolCall": { "tool": ${toolEnum}, "params": { } } (solo si actionRequired es CALL_TOOL),
  "entities": { ...claves relevantes del dominio según el contexto... },
  "suggestedReply": "texto claro y profesional",
  "ragSources": ["fuentes usadas"]
}`;
}

export class AIService {
  private geminiClient: GoogleGenAI | null = null;
  private geminiModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  private ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  private ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.geminiClient = new GoogleGenAI({ apiKey });
    }
  }

  public async processMessage(
    tenantId: string,
    message: string,
    businessContext?: any,
    conversationHistory?: any[],
    toolResult?: any,
    systemConfig?: SystemConfig
  ): Promise<AIProcessResult> {
    const start = Date.now();
    const currentInstruction = buildSystemInstruction(systemConfig);

    // 1. Consulta RAG en SQLite con aislamiento de tenant
    const relevantChunks = dbInstance.searchKnowledge(tenantId, message, 3);
    const ragContext = relevantChunks.length > 0
      ? `\n<normativas_institucionales_rag>\n${relevantChunks.map(c => `[${c.title}]: ${c.content}`).join('\n')}\n</normativas_institucionales_rag>`
      : '';

    // Historial conversacional delimitado como dato pasivo
    let historyContext = '';
    if (conversationHistory && conversationHistory.length > 0) {
      const sanitizedHistory = conversationHistory
        .map(h => `${h.role}: ${String(h.content).replace(/<\/?historial_conversacion>/g, '')}`)
        .join('\n');
      historyContext = `\n<historial_conversacion>\n${sanitizedHistory}\n</historial_conversacion>`;
    }

    // Resultado de tool calling inyectado dinámicamente si el backend lo resolvió
    const toolContext = toolResult
      ? `\n<resultado_herramienta>\n${JSON.stringify(toolResult, null, 2)}\n</resultado_herramienta>`
      : '';

    // Construcción del contexto de negocio seguro
    const businessData = businessContext
      ? `\n<contexto_negocio>\n${JSON.stringify(businessContext, null, 2)}\n</contexto_negocio>`
      : '';
    const userPrompt = `${businessData}${ragContext}${historyContext}${toolContext}\n\n<mensaje_usuario>\n${message}\n</mensaje_usuario>`;

    // 2. Cascada de inferencia: Nivel 1 (Gemini)
    if (this.geminiClient) {
      try {
        const geminiRes = await this.callGemini(userPrompt, currentInstruction);
        if (geminiRes) {
          return {
            ...geminiRes,
            latencyMs: Date.now() - start,
            engineUsed: 'gemini-3.5-flash-lite'
          };
        }
      } catch (err: any) {
        console.warn('[edi3-ai-production] Gemini falló, cayendo a Ollama local:', err.message);
      }
    }

    // 3. Cascada de inferencia: Nivel 2 (Ollama local, contingencia offline)
    try {
      const ollamaRes = await this.callOllama(userPrompt, currentInstruction);
      if (ollamaRes) {
        return {
          ...ollamaRes,
          latencyMs: Date.now() - start,
          engineUsed: 'ollama-qwen2.5:3b'
        };
      }
    } catch {
      // Ollama falló o no respondió
    }

    // 4. Sin motor disponible: el cliente decide la contingencia
    return {
      ok: false,
      error: 'INFERENCE_UNAVAILABLE',
      latencyMs: Date.now() - start
    };
  }

  private normalizeOutput(raw: any): Omit<AIAnalysisResult, 'latencyMs' | 'engineUsed'> | null {
    if (!raw || typeof raw !== 'object') return null;
    const parsed = AIOutputSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[edi3-ai-production] Salida de LLM inválida:', parsed.error.issues.map(i => i.message).join(', '));
      return null;
    }
    const d = parsed.data;
    return {
      intent: d.intent,
      confidence: d.confidence,
      actionRequired: d.actionRequired,
      toolCall: d.toolCall,
      entities: d.entities || {},
      suggestedReply: d.suggestedReply,
      ragSources: d.ragSources || []
    };
  }

  private async callOllama(prompt: string, instruction: string): Promise<Omit<AIAnalysisResult, 'latencyMs' | 'engineUsed'> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.ollamaModel,
          system: instruction,
          prompt,
          format: 'json',
          stream: false,
          options: {
            temperature: 0.1,
            num_ctx: 2048,
            num_thread: 4,
            top_k: 20,
            top_p: 0.8
          }
        })
      });

      clearTimeout(timeout);
      if (!response.ok) return null;

      const data = await response.json() as { response?: string };
      if (!data.response) return null;

      return this.normalizeOutput(JSON.parse(data.response));
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }

  private async callGemini(prompt: string, instruction: string): Promise<Omit<AIAnalysisResult, 'latencyMs' | 'engineUsed'> | null> {
    if (!this.geminiClient) return null;

    try {
      const response = await this.geminiClient.models.generateContent({
        model: this.geminiModel,
        contents: prompt,
        config: {
          systemInstruction: instruction,
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const text = response.text;
      if (!text) return null;
      return this.normalizeOutput(JSON.parse(text));
    } catch (err: any) {
      console.warn('[edi3-ai-production] Gemini call failed:', err.message);
      return null;
    }
  }
}

export const aiService = new AIService();
