import { GoogleGenAI } from '@google/genai';
import { dbInstance } from '../db.js';

export interface AIAnalysisResult {
  intent: string;
  confidence: number;
  actionRequired: 'REPLY_ONLY' | 'CREATE_PENDING_BOOKING' | 'ESCALATE_HUMAN' | 'CALL_TOOL';
  toolCall?: {
    tool: string;
    params: Record<string, any>;
  };
  entities: {
    doctorName?: string | null;
    preferredShift?: 'manana' | 'tarde' | 'indistinto';
    urgency?: 'baja' | 'media' | 'alta';
    [key: string]: any;
  };
  suggestedReply: string;
  ragSources: string[];
  latencyMs: number;
  engineUsed?: 'ollama-qwen2.5:3b' | 'gemini-2.5-flash' | 'gemini-3.5-flash-lite' | 'system-contingency';
}

export interface SystemConfig {
  systemRole?: string;
  emergencyGuardrail?: {
    terms: string[];
    reply: string;
    actionRequired: 'REPLY_ONLY' | 'CREATE_PENDING_BOOKING' | 'ESCALATE_HUMAN' | 'CALL_TOOL';
    intent?: string;
    urgency?: 'baja' | 'media' | 'alta';
  };
  restrictedGuardrail?: {
    terms: string[];
    reply: string;
    actionRequired: 'REPLY_ONLY' | 'CREATE_PENDING_BOOKING' | 'ESCALATE_HUMAN' | 'CALL_TOOL';
    intent?: string;
    urgency?: 'baja' | 'media' | 'alta';
  };
  allowedIntents?: string[];
}

function buildSystemInstruction(systemConfig?: SystemConfig): string {
  const role = systemConfig?.systemRole || 'Eres un asistente virtual oficial para atención al cliente.';
  const intents = systemConfig?.allowedIntents && systemConfig.allowedIntents.length > 0
    ? systemConfig.allowedIntents.map(i => `"${i}"`).join(' | ')
    : '"SOLICITUD_TURNO" | "CONSULTA_ARANCEL" | "CANCELACION_REPROGRAMACION" | "INFORMACION_HORARIOS" | "OTRO"';

  return `${role}
Tu función es clasificar la intención del usuario, extraer entidades y sugerir respuestas empáticas, profesionales y precisas.

REGLAS DE OPERACIÓN:
1. NUNCA confirmes reservas o turnos definitivos; solo puedes registrar una solicitud de reserva pendiente ('CREATE_PENDING_BOOKING') para aprobación humana.
2. Si el usuario pide un turno o cita fuera de la franja horaria permitida o configurada, avisa amablemente y ofrece la franja disponible.
3. TOOL CALLING / CONSULTAS DINÁMICAS:
   - Si el usuario pregunta por horarios, días de atención, o disponibilidad, y NO tienes la información completa en <resultado_herramienta> ni en el contexto, solicita la herramienta estableciendo "actionRequired": "CALL_TOOL", con "toolCall": { "tool": "getDoctorSchedule", "params": { "doctorName": "Nombre del profesional o entidad" } }.
   - Si el usuario pregunta por turnos disponibles, próximas fechas libres o huecos en agenda, y NO tienes los datos en <resultado_herramienta>, solicita la herramienta con "actionRequired": "CALL_TOOL", con "toolCall": { "tool": "getDoctorAvailability", "params": { "doctorName": "Nombre del profesional o entidad", "date": "YYYY-MM-DD" } }.
   - Cuando <resultado_herramienta> esté presente en el prompt con los datos devueltos por el backend, NO vuelvas a pedir la tool: responde al usuario con precisión usando esos datos ("actionRequired": "REPLY_ONLY" o "CREATE_PENDING_BOOKING").
4. Toda información sobre normas o políticas debe fundamentarse estrictamente en el contexto institucional o RAG provisto. Si no tienes datos, indica que la secretaría humana responderá a la brevedad.

Debes responder ÚNICAMENTE un objeto JSON válido con este esquema exacto:
{
  "intent": ${intents},
  "confidence": 0.0 a 1.0,
  "actionRequired": "REPLY_ONLY" | "CREATE_PENDING_BOOKING" | "ESCALATE_HUMAN" | "CALL_TOOL",
  "toolCall": {
    "tool": "getDoctorSchedule" | "getDoctorAvailability",
    "params": {
      "doctorName": string,
      "date": string (opcional)
    }
  } (solo obligatorio si actionRequired es CALL_TOOL),
  "entities": {
    "doctorName": string | null,
    "preferredShift": "manana" | "tarde" | "indistinto",
    "urgency": "baja" | "media" | "alta"
  },
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
    clinicContext?: any,
    conversationHistory?: any[],
    toolResult?: any,
    systemConfig?: SystemConfig
  ): Promise<AIAnalysisResult> {
    const start = Date.now();
    const currentInstruction = buildSystemInstruction(systemConfig);

    // 1. Invariantes Rápidas Defensivas (Guardrails antes del LLM sobre mensaje e historial)
    const lowerMsg = message.toLowerCase();
    const historyCombined = (conversationHistory || []).map(h => h.content.toLowerCase()).join(' ');
    const fullInputText = `${lowerMsg} ${historyCombined}`;

    // Jailbreak / Prompt Injection Detection
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
    if (injectionPatterns.some(p => fullInputText.includes(p))) {
      const isOverride = fullInputText.includes('[admin override]') || fullInputText.includes('override') || fullInputText.includes('<<sys>>');
      return {
        intent: 'OTRO',
        confidence: 0.99,
        actionRequired: isOverride ? 'ESCALATE_HUMAN' : 'REPLY_ONLY',
        entities: { doctorName: null, preferredShift: 'indistinto', urgency: 'baja' },
        suggestedReply: 'Hola. Como asistente virtual oficial, solo puedo orientarte sobre consultas, horarios y políticas establecidas.',
        ragSources: [],
        latencyMs: Date.now() - start,
        engineUsed: 'gemini-3.5-flash-lite'
      };
    }

    // 2. Consulta RAG en SQLite con Aislamiento de Tenant
    const relevantChunks = dbInstance.searchKnowledge(tenantId, message, 3);
    const ragContext = relevantChunks.length > 0
      ? `\n<normativas_institucionales_rag>\n${relevantChunks.map(c => `[${c.title}]: ${c.content}`).join('\n')}\n</normativas_institucionales_rag>`
      : '';

    // Historial conversacional delimitado como dato pasivo
    let historyContext = '';
    if (conversationHistory && conversationHistory.length > 0) {
      const sanitizedHistory = conversationHistory
        .map(h => `${h.role}: ${h.content.replace(/<\/?historial_conversacion>/g, '')}`)
        .join('\n');
      historyContext = `\n<historial_conversacion>\n${sanitizedHistory}\n</historial_conversacion>`;
    }

    // Resultado de Tool Calling inyectado dinámicamente si el backend lo resolvió
    const toolContext = toolResult
      ? `\n<resultado_herramienta>\n${JSON.stringify(toolResult, null, 2)}\n</resultado_herramienta>`
      : '';

    // Construcción del contexto de negocio seguro
    const clinicData = clinicContext ? `\n<contexto_negocio>\n${JSON.stringify(clinicContext, null, 2)}\n</contexto_negocio>` : '';
    const userPrompt = `${clinicData}${ragContext}${historyContext}${toolContext}\n\n<mensaje_usuario>\n${message}\n</mensaje_usuario>`;

    // 3. Cascada de Inferencia: Nivel 1 (Google Gemini 3.5 Flash Lite - ~1.5s de latencia)
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

    // 4. Cascada de Inferencia: Nivel 2 (Ollama Local qwen2.5:3b - contingencia offline)
    try {
      const ollamaRes = await this.callOllama(userPrompt, currentInstruction);
      if (ollamaRes) {
        return {
          ...ollamaRes,
          latencyMs: Date.now() - start,
          engineUsed: 'ollama-qwen2.5:3b'
        };
      }
    } catch (err) {
      // Ollama falló o no respondió
    }

    // 5. Contingencia sin conexión: respuesta limpia sin asumir doctores ni reglas fijas
    return {
      intent: 'OTRO',
      confidence: 0.5,
      actionRequired: 'ESCALATE_HUMAN',
      entities: { doctorName: null, preferredShift: 'indistinto', urgency: 'baja' },
      suggestedReply: 'En este momento estamos experimentando una interrupción técnica. La administración revisará tu mensaje a la brevedad.',
      ragSources: relevantChunks.map(c => c.title),
      latencyMs: Date.now() - start,
      engineUsed: 'system-contingency'
    };
  }

  private async callOllama(prompt: string, instruction: string): Promise<any | null> {
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

      return JSON.parse(data.response);
    } catch (err) {
      clearTimeout(timeout);
      return null;
    }
  }

  private async callGemini(prompt: string, instruction: string): Promise<any | null> {
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
      return JSON.parse(text);
    } catch (err: any) {
      console.warn('[edi3-ai-production] Gemini call failed:', err.message);
      return null;
    }
  }
}

export const aiService = new AIService();
