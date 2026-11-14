# Test de salud
GET http://localhost:8000/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"

# Test de procesamiento de mensaje válido
POST http://localhost:8000/api/v1/patient-message
Content-Type: application/json
{
  "tenantId": "cima-salud",
  "patientId": 12,
  "phone": "+5491122334455",
  "message": "Hola, necesito un turno con el Dr. Perez para el martes a la mañana"
}
HTTP 200
[Asserts]
jsonpath "$.intent" exists
jsonpath "$.confidence" >= 0.0
jsonpath "$.actionRequired" exists
jsonpath "$.suggestedReply" exists

# Test de payload inválido (sin mensaje)
POST http://localhost:8000/api/v1/patient-message
Content-Type: application/json
{
  "patientId": 12,
  "phone": "5491122334455"
}
HTTP 400
[Asserts]
jsonpath "$.error" exists
