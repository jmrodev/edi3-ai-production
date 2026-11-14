# User Story: US-003 - Cancelación y Reprogramación de Turnos
**Épica:** Gestión de Agenda Médica  
**Endpoint asociado:** `POST /api/v1/patient-message`

---

## Historia de Usuario
**Como** paciente con un turno agendado,  
**quiero** avisar por WhatsApp que no podré asistir o que necesito mover mi cita,  
**para que** el sistema libere mi turno o registre mi pedido de reprogramación para que la secretaría reorganice la agenda.

---

## Criterios de Aceptación (BDD: Given / When / Then)

### Escenario 1: Cancelación de turno explícita
- **Dado** un paciente con turno previo,
- **Cuando** envía el mensaje: `"Hola, lamentablemente no voy a poder ir a mi turno de hoy con el Dr. Perez, por favor cancelalo"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"CANCELACION_REPROGRAMACION"`,
- **Y** `actionRequired` es `"ESCALATE_HUMAN"`,
- **Y** `suggestedReply` confirma la recepción del pedido de cancelación y avisa que secretaría liberará el espacio.

---

### Escenario 2: Reprogramación de turno
- **Dado** un paciente que necesita cambiar de fecha,
- **Cuando** envía el mensaje: `"Se me complicó para el jueves, ¿me pueden pasar el turno con la Dra. López para el viernes que viene?"`,
- **Entonces** el sistema responde con HTTP 200,
- **Y** el campo `intent` es `"CANCELACION_REPROGRAMACION"`,
- **Y** `entities.doctorName` contiene `"López"`,
- **Y** `actionRequired` es `"ESCALATE_HUMAN"`.
