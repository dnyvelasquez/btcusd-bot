import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  BYBIT_API_KEY: z.string().min(1),
  BYBIT_API_SECRET: z.string().min(1),
  BYBIT_TESTNET: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().optional(),

  DATABASE_URL: z.string().url().optional(),
  LICENSE_KEY: z.string().uuid().optional(),
});

export const env = envSchema.parse(process.env);
