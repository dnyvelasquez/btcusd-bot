import { logger } from '@infra/logger/logger';
import { Application } from './app/application';
import { startDashboard } from '../apps/dashboard/server';

startDashboard(8002);

const app = new Application();

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down...');
  await app.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down...');
  await app.stop();
  process.exit(0);
});

app.start().catch((err: unknown) => {
  logger.error(err, 'Fatal error — bot crashed');
  process.exit(1);
});
