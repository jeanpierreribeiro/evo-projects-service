import { buildApp } from './app.js';
import { config } from './config/env.js';

const app = buildApp();

async function start() {
  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });
    console.log(`🚀 evo-projects-service running on http://${config.host}:${config.port}`);
    console.log(`📁 Healthcheck available at http://${config.host}:${config.port}/health`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
