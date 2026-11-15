import { z } from 'zod';

export const DoctorContextSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(2).max(100),
  specialty: z.string().min(2).max(100),
  consultationPrice: z.number().positive().min(0.01).optional(),
  nextFreeSlot: z.string().max(50).nullable().optional(),
  schedules: z.array(z.string()).max(20).optional()
}).strict();

export const ClinicContextSchema = z.object({
  clinicName: z.string().max(120).optional(),
  currentTime: z.string().max(120).optional(),
  secretaryHours: z.string().max(200).optional(),
  address: z.string().max(200).optional(),
  doctors: z.array(DoctorContextSchema).max(30).optional()
}).strict();

export const PatientMessageRequestSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9_-]+$/).min(2).max(64),
  patientId: z.number().int().positive().max(2147483647),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Formato telefónico E.164 inválido'),
  message: z.string().min(1).max(1000).refine(val => !val.includes('\0'), 'Caracteres nulos prohibidos'),
  clinicContext: ClinicContextSchema.optional(),
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
