import { z } from 'zod';

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  params: z.array(z.string().min(1).max(50)).max(20).optional()
}).strict();

export const GuardrailRuleSchema = z.object({
  terms: z.array(z.string().min(1).max(100)).max(50),
  reply: z.string().min(1).max(1000),
  actionRequired: z.enum(['REPLY_ONLY', 'CREATE_PENDING_BOOKING', 'ESCALATE_HUMAN', 'CALL_TOOL']),
  intent: z.string().min(1).max(50).default('OTRO'),
  urgency: z.enum(['baja', 'media', 'alta']).default('baja')
}).strict();

/**
 * Configuración genérica provista por el cliente. El motor de inferencia no asume
 * ningún dominio: todo el comportamiento (prompt, reglas, tools, intenciones y
 * mensajes de guardrail) se compone a partir de estos campos.
 */
export const SystemConfigSchema = z.object({
  systemPrompt: z.string().min(10).max(8000).optional(),
  systemRole: z.string().min(10).max(2000).optional(),
  operationalRules: z.array(z.string().min(1).max(500)).max(50).optional(),
  availableTools: z.array(ToolDefinitionSchema).max(20).optional(),
  neutralReply: z.string().min(1).max(1000).optional(),
  emergencyGuardrail: GuardrailRuleSchema.optional(),
  restrictedGuardrail: GuardrailRuleSchema.optional(),
  allowedIntents: z.array(z.string().min(1).max(50)).max(20).optional()
}).strict();

const OpenContextSchema = z.record(z.string(), z.any());

export const PatientMessageRequestSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9_-]+$/).min(2).max(64),
  patientId: z.number().int().positive().max(2147483647),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Formato telefónico E.164 inválido'),
  message: z.string().min(1).max(1000).refine(val => !val.includes('\0'), 'Caracteres nulos prohibidos'),
  systemConfig: SystemConfigSchema.optional(),
  businessContext: OpenContextSchema.optional(),
  /** @deprecated usar businessContext. Se mantiene por compatibilidad. */
  clinicContext: OpenContextSchema.optional(),
  toolResult: z.object({
    tool: z.string().min(1).max(100),
    data: z.any()
  }).optional(),
  conversationHistory: z.array(z.object({
    role: z.enum(['user', 'assistant', 'paciente', 'asistente']),
    content: z.string().min(1).max(2000)
  }).strict()).max(10).optional()
}).strict();

export const KnowledgeDocumentRequestSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9_-]+$/).min(2).max(64),
  documentId: z.string().regex(/^[a-z0-9_-]+$/).min(2).max(64),
  title: z.string().min(3).max(200).refine(val => !val.includes('\0'), 'Caracteres nulos prohibidos'),
  content: z.string().min(10).max(50000).refine(val => !val.includes('\0'), 'Caracteres nulos prohibidos')
}).strict();

export type PatientMessageRequest = z.infer<typeof PatientMessageRequestSchema>;
export type KnowledgeDocumentRequest = z.infer<typeof KnowledgeDocumentRequestSchema>;
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
export type GuardrailRule = z.infer<typeof GuardrailRuleSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
