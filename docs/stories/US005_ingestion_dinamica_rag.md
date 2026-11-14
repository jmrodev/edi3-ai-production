# User Story: US-005 - Ingestión Dinámica de Normativas Institucionales (RAG)
**Épica:** Base de Conocimiento Autogestionada por la Clínica  
**Endpoint asociado:** `POST /api/v1/knowledge/documents`

---

## Historia de Usuario
**Como** administradora o secretaria de una institución médica,  
**quiero** actualizar los aranceles, normativas de recetas o instrucciones de estudios desde mi panel web sin programar,  
**para que** el microservicio de IA aprenda los cambios de inmediato y responda a los pacientes con las reglas vigentes.

---

## Criterios de Aceptación (BDD: Given / When / Then)

### Escenario 1: Ingestión exitosa de nueva normativa
- **Dado** una clínica cliente con `tenantId: "cima-salud"`,
- **Cuando** envía un payload válido con `documentId: "aranceles_2026"`, `title: "Valores de Consulta Noviembre 2026"` y `content: "Consulta médica general: $65.000..."`,
- **Entonces** el sistema responde con HTTP 201 Created,
- **Y** el campo `status` es `"indexed"`,
- **Y** `documentId` coincide con `"aranceles_2026"`,
- **Y** `chunksIndexed` es mayor a 0.

---

### Escenario 2: Rechazo de Payload Malformado o Ataque de Traversal
- **Dado** un intento de carga con `tenantId: "../admin"` o `content` vacío,
- **Cuando** se envía la solicitud al endpoint,
- **Entonces** el sistema rechaza la petición con HTTP 400 Bad Request,
- **Y** no se altera ni contamina ninguna partición de la base vectorial.
