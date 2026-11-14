# User Story: US-001 - Solicitud de Turno Médico Inteligente
**Épica:** Atención al Paciente vía WhatsApp (EDI 3 - Secretary App Integration)  
**Endpoint asociado:** `POST /api/v1/patient-message`

---

## Historia de Usuario
**Como** paciente de la clínica médica,  
**quiero** enviar un mensaje informal por WhatsApp pidiendo un turno con mi médico o en una franja horaria determinada,  
**para que** el sistema entienda mi pedido, extraiga mis preferencias y genere una pre-reserva ordenada para la secretaría.

---

## Criterios de Aceptación (BDD: Given / When / Then)

### Escenario 1: Solicitud con médico y turno explícitos (Happy Path estándar)
- **Dado** un paciente con ID válido (`12`) y teléfono `"+5491122334455"`,
- **Cuando** envía el mensaje: `"Hola, quisiera un turno con el Dr. Gómez para la semana que viene por la mañana"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"SOLICITUD_TURNO"`,
- **Y** el campo `confidence` es mayor o igual a `0.85`,
- **Y** `entities.doctorName` contiene `"Gómez"`,
- **Y** `entities.preferredShift` es `"manana"`,
- **Y** `actionRequired` es `"CREATE_PENDING_BOOKING"`.

---

### Escenario 2: Solicitud sin médico pero con turno preferido (Médico de cabecera implícito)
- **Dado** un paciente que consulta por un turno general,
- **Cuando** envía el mensaje: `"Hola, necesito sacar un turno para control anual por la tarde"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"SOLICITUD_TURNO"`,
- **Y** `entities.doctorName` es `null`,
- **Y** `entities.preferredShift` es `"tarde"`,
- **Y** `actionRequired` es `"CREATE_PENDING_BOOKING"`.

---

### Escenario 3: Desambiguación médica requerida
- **Dado** un paciente que pide turno con un apellido común compartido por varios profesionales (ej. `"Perez"`),
- **Cuando** envía el mensaje: `"Quiero atenderme con Perez el viernes"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** `intent` es `"SOLICITUD_TURNO"`,
- **Y** `actionRequired` es `"REPLY_ONLY"`,
- **Y** `suggestedReply` solicita cordialmente aclarar a cuál de los profesionales se refiere.
