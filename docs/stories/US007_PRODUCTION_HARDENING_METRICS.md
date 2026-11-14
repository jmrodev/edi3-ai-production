# Historia de Usuario US-007: Hardening de Producción, Observabilidad y Rate Limiting

## 1. Declaración de Valor
**Como** operador de infraestructura y responsable del microservicio clínico,  
**Quiero** contar con limitación de tasa (rate limiting), monitoreo de consumo de tokens y censura de datos sensibles (PII),  
**Para que** el sistema no sea víctima de ataques de denegación de servicio (Denial of Wallet), cumpla con regulaciones de privacidad médica y mantenga trazabilidad en tiempo real.

---

## 2. Criterios de Aceptación (BDD)

### Escenario 1: Monitoreo de Observabilidad (`GET /metrics`)
* **Dado** que el microservicio está en ejecución y ha procesado solicitudes,
* **Cuando** se realiza una petición HTTP `GET /metrics`,
* **Entonces** el servidor responde `200 OK` con un objeto JSON que incluye:
  - `uptimeSeconds`: tiempo de actividad.
  - `requestsTotal`: total de requests recibidas por endpoint.
  - `tokensInEstimated`: tokens de entrada estimados procesados.
  - `tokensOutEstimated`: tokens de salida generados.
  - `costEstimateUsd`: costo acumulado estimado según pricing de mercado.
  - `engineUsage`: desglose por motor (`ollama`, `gemini`, `fallback`).

### Escenario 2: Protección contra Abuso y Denial of Wallet (Rate Limiting)
* **Dado** un cliente o tenant enviando ráfagas continuas de peticiones abusivas,
* **Cuando** excede el umbral configurado por minuto (ej. 100 req/min),
* **Entonces** el servidor responde HTTP `429 Too Many Requests` con encabezados estándar `Retry-After`.

### Escenario 3: Censura y Redacción de PII (Personally Identifiable Information)
* **Dado** un mensaje de paciente entrante con número telefónico y datos de salud,
* **Cuando** se emiten logs internos de depuración o auditoría,
* **Entonces** el número telefónico se ofusca (ej. `+549******2233`) y jamás se imprimen datos de salud en texto plano en la consola de producción.

### Escenario 4: CI Continuo con GitHub Actions
* **Dado** el repositorio en GitHub,
* **Cuando** se realiza un `git push` a `main`,
* **Entonces** un workflow ejecuta automáticamente `pnpm test` corriendo los 64+ tests Hurl garantizando cero regresiones.
