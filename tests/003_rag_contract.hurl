# Test 1: Ingestión exitosa de documento RAG (Happy Path) contra Mock Server
POST http://localhost:4010/api/v1/knowledge/documents
Content-Type: application/json
{
  "tenantId": "cima-salud",
  "documentId": "normativa-osde-reintegros",
  "title": "Normativa Reintegros OSDE 2026",
  "content": "Para reintegros de consultas de psicología con OSDE se requiere factura B o C con diagnóstico según CIE-10."
}

HTTP 201
[Asserts]
jsonpath "$.status" == "indexed"
jsonpath "$.chunksIndexed" >= 1
