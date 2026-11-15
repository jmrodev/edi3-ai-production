import { GoogleGenAI, Type } from '@google/genai';
import { dbInstance } from '../db.js';

export interface AIAnalysisResult {
  intent: 'SOLICITUD_TURNO' | 'CONSULTA_ARANCEL' | 'CANCELACION_REPROGRAMACION' | 'INFORMACION_HORARIOS' | 'OTRO';
  confidence: number;
  actionRequired: 'REPLY_ONLY' | 'CREATE_PENDING_BOOKING' | 'ESCALATE_HUMAN' | 'CALL_TOOL';
  toolCall?: {
    tool: 'getDoctorSchedule' | 'getDoctorAvailability';
    params: {
      doctorId?: number;
      doctorName?: string;
      date?: string;
    };
  };
  entities: {
    doctorName: string | null;
    preferredShift: 'manana' | 'tarde' | 'indistinto';
    urgency: 'baja' | 'media' | 'alta';
  };
  suggestedReply: string;
  ragSources: string[];
  latencyMs: number;
  engineUsed?: 'ollama-qwen2.5:3b' | 'gemini-2.5-flash' | 'gemini-3.5-flash-lite' | 'deterministic-fallback';
}

const SYSTEM_INSTRUCTION = `Eres el asistente virtual clínico oficial de atención por mensajería para consultorios médicos.
Tu función es clasificar la intención del paciente, extraer entidades médicas y sugerir respuestas empáticas, profesionales y precisas.

REGLAS INQUEBRANTABLES DE NEGOCIO Y SEGURIDAD:
1. NUNCA confirmes turnos definitivos; solo puedes registrar una solicitud de reserva pendiente ('CREATE_PENDING_BOOKING') para aprobación de la secretaría humana.
2. Si el paciente no aclara el médico pero tiene un médico de cabecera en el contexto, genera una contrapregunta de confirmación y pon 'REPLY_ONLY'.
3. TOOL CALLING / CONSULTAS DINÁMICAS:
   - Si el paciente pregunta por horarios, días de atención, o si un médico está atendiendo, y NO tienes la información completa en <resultado_herramienta> ni en el contexto, solicita la herramienta estableciendo "actionRequired": "CALL_TOOL", con "toolCall": { "tool": "getDoctorSchedule", "params": { "doctorName": "Nombre del médico" } }.
   - Si el paciente pregunta por turnos disponibles, próximas fechas libres o huecos en agenda, y NO tienes los turnos en <resultado_herramienta>, solicita la herramienta con "actionRequired": "CALL_TOOL", con "toolCall": { "tool": "getDoctorAvailability", "params": { "doctorName": "Nombre del médico", "date": "YYYY-MM-DD" } }.
   - Cuando <resultado_herramienta> esté presente en el prompt con los datos devueltos por el backend, NO vuelvas a pedir la tool: responde al paciente con precisión usando esos datos ("actionRequired": "REPLY_ONLY" o "CREATE_PENDING_BOOKING").
4. CERO PRESCRIPCIÓN: Prohibido indicar medicamentos o dosis. Si mencionan fármacos controlados (clonazepam, morfina), asigna intent 'OTRO' y actionRequired 'ESCALATE_HUMAN'.
5. TRIAGE VITAL: Dolor de pecho, dificultad respiratoria o síntomas coronarios exigen derivación urgente a emergencias (107/911) con urgency 'alta' y 'ESCALATE_HUMAN'.
6. Toda información sobre normas o coberturas debe fundamentarse estrictamente en el contexto institucional o RAG provisto. Si no tienes datos, indica que la secretaría humana responderá a la brevedad.

Debes responder ÚNICAMENTE un objeto JSON válido con este esquema exacto:
{
  "intent": "SOLICITUD_TURNO" | "CONSULTA_ARANCEL" | "CANCELACION_REPROGRAMACION" | "INFORMACION_HORARIOS" | "OTRO",
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
    toolResult?: any
  ): Promise<AIAnalysisResult> {
    const start = Date.now();

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
        suggestedReply: 'Hola. Como asistente virtual de la secretaría médica, solo puedo orientarte sobre turnos, horarios y normativas del consultorio.',
        ragSources: [],
        latencyMs: Date.now() - start,
        engineUsed: 'deterministic-fallback'
      };
    }

    // Triage de Emergencia Vital
    const urgentTerms = ['pecho', 'infarto', 'respirar', 'aire', 'desmayo', 'asfixia', 'coronario'];
    if (urgentTerms.some(term => fullInputText.includes(term))) {
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
    if (drugs.some(d => fullInputText.includes(d))) {
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

    // Construcción del contexto clínico seguro
    const clinicData = clinicContext ? `\n<contexto_clinico>\n${JSON.stringify(clinicContext, null, 2)}\n</contexto_clinico>` : '';
    const userPrompt = `${clinicData}${ragContext}${historyContext}${toolContext}\n\n<mensaje_paciente>\n${message}\n</mensaje_paciente>`;

    // 3. Cascada de Inferencia: Nivel 1 (Google Gemini 3.5 Flash Lite - ~1.5s de latencia)
    if (this.geminiClient) {
      try {
        const geminiRes = await this.callGemini(userPrompt);
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
      const ollamaRes = await this.callOllama(userPrompt);
      if (ollamaRes) {
        return {
          ...ollamaRes,
          latencyMs: Date.now() - start,
          engineUsed: 'ollama-qwen2.5:3b'
        };
      }
    } catch (err) {
      // Ollama falló o no respondió -> cae al nivel 3
    }

    // 5. Nivel 3: Fallback Determinista Seguro
    return this.deterministicFallback(message, clinicContext, relevantChunks, Date.now() - start, conversationHistory);
  }

  private async callOllama(prompt: string): Promise<any | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20s para inferencia local en CPU sin abort prematuro

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
        model: this.geminiModel,
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
    } catch (err: any) {
      console.warn('[edi3-ai-production] Gemini call failed:', err.message);
      return null;
    }
  }

  private deterministicFallback(
    message: string,
    clinicContext: any,
    relevantChunks: any[],
    elapsedMs: number,
    conversationHistory?: any[]
  ): AIAnalysisResult {
    const lowerMsg = message.toLowerCase();

    // Análisis de historial para correferencias ("con ella", "con el", "confirmo ese")
    let historyDoctor: string | null = null;
    let historyPrefersFemale = lowerMsg.includes('ella');
    let historyPrefersMale = lowerMsg.includes('con el') || lowerMsg.includes('con él');

    if (conversationHistory && conversationHistory.length > 0) {
      const fullHistoryText = conversationHistory.map(h => h.content).join(' ').toLowerCase();
      if (clinicContext?.doctors) {
        for (const doc of clinicContext.doctors) {
          const docLower = doc.name.toLowerCase();
          if (fullHistoryText.includes(docLower)) {
            if (historyPrefersFemale && (docLower.includes('dra') || docLower.includes('dra.'))) {
              historyDoctor = doc.name;
              break;
            } else if (historyPrefersMale && (docLower.includes('dr.') || docLower.includes('dr '))) {
              historyDoctor = doc.name;
              break;
            } else if (!historyDoctor) {
              historyDoctor = doc.name;
            }
          }
        }
      }
    }

    // Turno
    const isBooking = lowerMsg.includes('turno') || lowerMsg.includes('cita') || lowerMsg.includes('consulta')
      || lowerMsg.includes('ella') || lowerMsg.includes('confirmo') || lowerMsg.includes('viene bien')
      || lowerMsg.includes('quedamos');

    if (isBooking) {
      const isMadrugada = lowerMsg.includes('madrugada') || lowerMsg.includes('3:30');
      const shift = lowerMsg.includes('tarde') ? 'tarde' :
                    (lowerMsg.includes('mañana') || lowerMsg.includes('manana')) ? 'manana' : 'indistinto';

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

      const finalDoctor = matchedDoctor || historyDoctor || (clinicContext?.doctors?.[0]?.name ?? 'Profesional de cabecera');

      return {
        intent: 'SOLICITUD_TURNO',
        confidence: 0.94,
        actionRequired: isMadrugada ? 'REPLY_ONLY' : 'CREATE_PENDING_BOOKING',
        entities: {
          doctorName: finalDoctor,
          preferredShift: shift,
          urgency: 'baja'
        },
        suggestedReply: isMadrugada
          ? 'Hola. Los turnos de atención se brindan exclusivamente en horario hábil diurno.'
          : `Hola! Registramos tu solicitud para consultar turnos disponibles con ${finalDoctor}. La secretaría revisará la agenda y te enviará la confirmación definitiva a la brevedad.`,
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
