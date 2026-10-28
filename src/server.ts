import { buildApp } from './app.js';
import { config } from './config/env.js';
import prisma from './db/prisma.js';

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

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, closing server gracefully...`);
  try {
    await app.close();
    await prisma.$disconnect();
    console.log('Server and database disconnected cleanly.');
    process.exit(0);
  } catch (err) {
    console.error('Error during graceful shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
