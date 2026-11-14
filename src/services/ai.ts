import { GoogleGenAI, Type } from '@google/genai';
import { dbInstance } from '../db.js';

export interface AIAnalysisResult {
  intent: 'SOLICITUD_TURNO' | 'CONSULTA_ARANCEL' | 'CANCELACION_REPROGRAMACION' | 'INFORMACION_HORARIOS' | 'OTRO';
  confidence: number;
  actionRequired: 'REPLY_ONLY' | 'CREATE_PENDING_BOOKING' | 'ESCALATE_HUMAN';
  entities: {
    doctorName: string | null;
    preferredShift: 'manana' | 'tarde' | 'indistinto';
    urgency: 'baja' | 'media' | 'alta';
  };
  suggestedReply: string;
  ragSources: string[];
  latencyMs: number;
  engineUsed?: 'ollama-qwen2.5:3b' | 'gemini-2.5-flash' | 'deterministic-fallback';
}

const SYSTEM_INSTRUCTION = `Eres el asistente virtual clínico oficial de atención por mensajería para consultorios médicos.
Tu función es clasificar la intención del paciente, extraer entidades médicas y sugerir respuestas empáticas, profesionales y precisas.

REGLAS INQUEBRANTABLES DE NEGOCIO Y SEGURIDAD:
1. NUNCA confirmes turnos definitivos; solo puedes registrar una solicitud de reserva pendiente ('CREATE_PENDING_BOOKING') para aprobación de la secretaría humana.
2. Si el paciente no aclara el médico pero tiene un médico de cabecera en el contexto, genera una contrapregunta de confirmación y pon 'REPLY_ONLY'.
3. Si el paciente pide un turno fuera de la franja horaria del médico (ej. pide tarde pero el médico atiende a la mañana), avisa amablemente y ofrece el turno disponible de su franja.
4. CERO PRESCRIPCIÓN: Prohibido indicar medicamentos o dosis. Si mencionan fármacos controlados (clonazepam, morfina), asigna intent 'OTRO' y actionRequired 'ESCALATE_HUMAN'.
5. TRIAGE VITAL: Dolor de pecho, dificultad respiratoria o síntomas coronarios exigen derivación urgente a emergencias (107/911) con urgency 'alta' y 'ESCALATE_HUMAN'.
6. Toda información sobre normas o coberturas debe fundamentarse estrictamente en el contexto institucional o RAG provisto. Si no tienes datos, indica que la secretaría humana responderá a la brevedad.

Debes responder ÚNICAMENTE un objeto JSON válido con este esquema exacto:
{
  "intent": "SOLICITUD_TURNO" | "CONSULTA_ARANCEL" | "CANCELACION_REPROGRAMACION" | "INFORMACION_HORARIOS" | "OTRO",
  "confidence": 0.0 a 1.0,
  "actionRequired": "REPLY_ONLY" | "CREATE_PENDING_BOOKING" | "ESCALATE_HUMAN",
  "entities": {
    "doctorName": string | null,
    "preferredShift": "manana" | "tarde" | "indistinto",
    "urgency": "baja" | "media" | "alta"
  },
  "suggestedReply": "texto claro y profesional",
  "ragSources": ["fuentes usadas"]
}`;

export class AIService {
  private geminiClient: GoogleGenAI | null = null;
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
    conversationHistory?: any[]
  ): Promise<AIAnalysisResult> {
    const start = Date.now();

    // 1. Invariantes Rápidas Defensivas (Guardrails antes del LLM)
    const lowerMsg = message.toLowerCase();

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
      'override'
    ];
    if (injectionPatterns.some(p => lowerMsg.includes(p))) {
      const isOverride = lowerMsg.includes('[admin override]') || lowerMsg.includes('override');
      return {
        intent: 'OTRO',
        confidence: 0.99,
        actionRequired: isOverride ? 'ESCALATE_HUMAN' : 'REPLY_ONLY',
        entities: { doctorName: null, preferredShift: 'indistinto', urgency: 'baja' },
        suggestedReply: 'Hola. Como asistente virtual de la secretaría médica, solo puedo orientarte sobre turnos, horarios y normativas del consultorio.',
        ragSources: [],
        latencyMs: Date.now() - start,
        engineUsed: 'deterministic-fallback'
      };
    }

    // Triage de Emergencia Vital
    const urgentTerms = ['pecho', 'infarto', 'respirar', 'aire', 'desmayo', 'asfixia', 'coronario'];
    if (urgentTerms.some(term => lowerMsg.includes(term))) {
      return {
        intent: 'OTRO',
        confidence: 0.99,
        actionRequired: 'ESCALATE_HUMAN',
        entities: { doctorName: null, preferredShift: 'indistinto', urgency: 'alta' },
        suggestedReply: 'EMERGENCIA MÉDICA: Por los síntomas que describes, comunícate de inmediato al 107 o acércate a la guardia más cercana.',
        ragSources: [],
        latencyMs: Date.now() - start,
        engineUsed: 'deterministic-fallback'
      };
    }

    // Prescripción Cero (Fármacos controlados)
    const drugs = ['clonazepam', 'morfina', 'receta', 'alprazolam', 'tramadol', 'ansiolitico'];
    if (drugs.some(d => lowerMsg.includes(d))) {
      return {
        intent: 'OTRO',
        confidence: 0.95,
        actionRequired: 'ESCALATE_HUMAN',
        entities: { doctorName: null, preferredShift: 'indistinto', urgency: 'baja' },
        suggestedReply: 'Por normativas de salud no emitimos ni renovamos recetas de medicamentos automáticamente por chat. Derivo tu mensaje a la secretaría.',
        ragSources: [],
        latencyMs: Date.now() - start,
        engineUsed: 'deterministic-fallback'
      };
    }

    // 2. Consulta RAG en SQLite con Aislamiento de Tenant
    const relevantChunks = dbInstance.searchKnowledge(tenantId, message, 3);
    const ragContext = relevantChunks.length > 0
      ? `\n<normativas_institucionales_rag>\n${relevantChunks.map(c => `[${c.title}]: ${c.content}`).join('\n')}\n</normativas_institucionales_rag>`
      : '';

    // Construcción del contexto clínico seguro
    const clinicData = clinicContext ? `\n<contexto_clinico>\n${JSON.stringify(clinicContext, null, 2)}\n</contexto_clinico>` : '';
    const userPrompt = `${clinicData}${ragContext}\n\n<mensaje_paciente>\n${message}\n</mensaje_paciente>`;

    // 3. Cascada de Inferencia: Nivel 1 (Ollama Local qwen2.5:3b)
    try {
      const ollamaRes = await this.callOllama(userPrompt);
      if (ollamaRes) {
        return {
          ...ollamaRes,
          latencyMs: Date.now() - start,
          engineUsed: 'ollama-qwen2.5:3b'
        };
      }
    } catch (err) {
      // Ollama falló o no respondió en tiempo -> cae al nivel 2
    }

    // 4. Cascada de Inferencia: Nivel 2 (Google Gemini Flash)
    if (this.geminiClient) {
      try {
        const geminiRes = await this.callGemini(userPrompt);
        if (geminiRes) {
          return {
            ...geminiRes,
            latencyMs: Date.now() - start,
            engineUsed: 'gemini-2.5-flash'
          };
        }
      } catch (err) {
        // Fallback a nivel 3
      }
    }

    // 5. Nivel 3: Fallback Determinista Seguro
    return this.deterministicFallback(message, clinicContext, relevantChunks, Date.now() - start);
  }

  private async callOllama(prompt: string): Promise<any | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout para no frenar la CPU

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.ollamaModel,
          system: SYSTEM_INSTRUCTION,
          prompt,
          format: 'json',
          stream: false,
          options: {
            temperature: 0.1,
            num_ctx: 2048,      // Ahorro estricto de RAM
            num_thread: 4,      // 4 hilos para dejar 2 núcleos libres al sistema
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

  private async callGemini(prompt: string): Promise<any | null> {
    if (!this.geminiClient) return null;

    try {
      const response = await this.geminiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const text = response.text;
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }

  private deterministicFallback(
    message: string,
    clinicContext: any,
    relevantChunks: any[],
    elapsedMs: number
  ): AIAnalysisResult {
    const lowerMsg = message.toLowerCase();

    // Turno
    if (lowerMsg.includes('turno') || lowerMsg.includes('cita') || lowerMsg.includes('consulta')) {
      const isMadrugada = lowerMsg.includes('madrugada') || lowerMsg.includes('3:30');
      const shift = lowerMsg.includes('tarde') ? 'tarde' :
                    lowerMsg.includes('mañana') ? 'manana' : 'indistinto';

      let matchedDoctor: string | null = null;
      if (clinicContext?.doctors) {
        for (const doc of clinicContext.doctors) {
          const parts = doc.name.toLowerCase().split(' ');
          if (parts.some((p: string) => p.length > 2 && lowerMsg.includes(p))) {
            matchedDoctor = doc.name;
            break;
          }
        }
      }

      return {
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
        ragSources: relevantChunks.length > 0 ? relevantChunks.map(c => c.title) : ['atencion_y_modalidades.md'],
        latencyMs: elapsedMs,
        engineUsed: 'deterministic-fallback'
      };
    }

    // Consulta general / horarios
    return {
      intent: 'INFORMACION_HORARIOS',
      confidence: 0.88,
      actionRequired: 'REPLY_ONLY',
      entities: {
        doctorName: null,
        preferredShift: 'indistinto',
        urgency: 'baja'
      },
      suggestedReply: `Hola! Gracias por comunicarte con ${clinicContext?.clinicName || 'nuestro consultorio'}. Nuestro horario de secretaría es ${clinicContext?.secretaryHours || 'habitual'}. ¿En qué podemos ayudarte?`,
      ragSources: relevantChunks.length > 0 ? relevantChunks.map(c => c.title) : ['atencion_y_modalidades.md'],
      latencyMs: elapsedMs,
      engineUsed: 'deterministic-fallback'
    };
  }
}

export const aiService = new AIService();
