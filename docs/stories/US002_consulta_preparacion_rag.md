# User Story: US-002 - Consulta de Normativas y Preparación de Estudios (RAG)
**Épica:** Asistencia Informativa Médica y Administrativa  
**Endpoint asociado:** `POST /api/v1/patient-message`

---

## Historia de Usuario
**Como** paciente que tiene programado un estudio médico,  
**quiero** consultar por WhatsApp qué preparación previa requiero (ayuno, retención de líquidos, suspensión de medicación),  
**para que** el sistema me informe con precisión citando las normativas oficiales del consultorio sin alucinar.

---

## Criterios de Aceptación (BDD: Given / When / Then)

### Escenario 1: Consulta de preparación para ecografía abdominal (Respaldo RAG)
- **Dado** un paciente con dudas sobre su estudio,
- **Cuando** envía el mensaje: `"Tengo ecografía mañana a las 8, ¿tengo que ir en ayunas o tomar agua?"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"CONSULTA_PREPARACION"`,
- **Y** `actionRequired` es `"REPLY_ONLY"`,
- **Y** `ragSources` incluye `"normativas_estudios_ecografia.md"`,
- **Y** `suggestedReply` detalla el protocolo de 8 hs de ayuno citando la normativa de la clínica.

---

### Escenario 2: Consulta de horario de atención y ubicación
- **Dado** un paciente que consulta datos administrativos,
- **Cuando** envía el mensaje: `"¿Hasta qué hora atienden hoy y en qué dirección están?"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"INFORMACION_HORARIOS"`,
- **Y** `actionRequired` es `"REPLY_ONLY"`,
- **Y** `suggestedReply` devuelve el horario oficial de secretaría (8:00 a 19:00 hs) y la dirección física.

---

### Escenario 3: Pregunta sobre un estudio no contemplado (Evidencia Insuficiente)
- **Dado** un paciente que consulta por un procedimiento que no se realiza en la clínica,
- **Cuando** envía: `"¿Hacen resonancia magnética con contraste?"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** `intent` es `"CONSULTA_PREPARACION"`,
- **Y** `actionRequired` es `"ESCALATE_HUMAN"`,
- **Y** `suggestedReply` reconoce explícitamente que no dispone de esa información y deriva la consulta a la secretaría.
