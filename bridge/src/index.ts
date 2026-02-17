import { createVirtualHyperCoreRuntime } from './app.js';
import { loadAppConfig } from './config/app-config.js';
import { Logger } from './logging/logger.js';

const logger = new Logger('main');

async function main(): Promise<void> {
  const config = loadAppConfig();
  const runtime = createVirtualHyperCoreRuntime(config);
  await runtime.start();

  const shutdown = async () => {
    logger.info('shutting down runtime');
    await runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error) => {
  logger.error('fatal runtime error', {
    error: String(error),
  });
  process.exit(1);
});
