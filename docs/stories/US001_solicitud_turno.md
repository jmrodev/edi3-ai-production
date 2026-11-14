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

### Escenario 2: Solicitud sin médico explícito (Contrapregunta Obligatoria de Profesional de Cabecera)
- **Dado** un paciente que consulta por un turno general sin nombrar al médico,
- **Y** en el historial o contexto figura un profesional previo registrado (ej. `"Dra. Maria Cecilia Scheerle"`),
- **Cuando** envía el mensaje: `"Hola, necesito sacar un turno para control anual la semana que viene"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"SOLICITUD_TURNO"`,
- **Y** el campo `actionRequired` es `"REPLY_ONLY"`,
- **Y** `entities.requiresConfirmation` es `true`,
- **Y** `suggestedReply` formula una contrapregunta cordial: *"En nuestros registros figura que tu última consulta fue con la Dra. Maria Cecilia Scheerle (Psiquiatría). ¿Deseas solicitar el turno con ella o prefieres consultar por otro especialista?"*.

---

### Escenario 3: Solicitud con Franja Horaria Incompatible (Aviso de Turno de Médico)
- **Dado** un paciente que pide turno a la mañana con un profesional que solo atiende de tarde según su agenda,
- **Cuando** envía el mensaje: `"Quiero un turno con la Dra. Scheerle el martes por la mañana"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"SOLICITUD_TURNO"`,
- **Y** `actionRequired` es `"REPLY_ONLY"`,
- **Y** `suggestedReply` informa amablemente la restricción: *"Ten en cuenta que la Dra. Scheerle atiende únicamente en el turno tarde. El primer turno disponible es el martes a las 15:00 hs. ¿Te gustaría que reservemos ese espacio?"*.

---

### Escenario 4: Desambiguación médica requerida (Mismo apellido)
- **Dado** un paciente que pide turno con un apellido común compartido por varios profesionales (ej. `"Perez"`),
- **Cuando** envía el mensaje: `"Quiero atenderme con Perez el viernes"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** `intent` es `"SOLICITUD_TURNO"`,
- **Y** `actionRequired` es `"REPLY_ONLY"`,
- **Y** `suggestedReply` solicita cordialmente aclarar a cuál de los profesionales se refiere.
