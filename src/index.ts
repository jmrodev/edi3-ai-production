import { buildApp } from './app.js';

const app = buildApp();
const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST || '0.0.0.0';

async function start() {
  try {
    await app.listen({ port, host });
    console.log(`[edi3-ai-production] Servidor HTTP escuchando en http://${host}:${port}`);
  } catch (err) {
    console.error('Error al iniciar el servidor:', err);
    process.exit(1);
  }
}

start();
