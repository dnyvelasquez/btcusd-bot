import fs from 'fs';
import path from 'path';

import postgres from 'postgres';

import { logger } from '@infra/logger/logger';
import { env } from '@config/env';

const CACHE_PATH = path.resolve(__dirname, '..', '..', '..', 'license-cache.json');

interface LicenseCache { owner_name: string; trade_mode: string; }

function readLicenseCache(): LicenseCache | null {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as LicenseCache; }
  catch { return null; }
}

export interface JournalEntry {
  ticket: number;
  bybitAccount: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  plannedRr: number;
  riskAmount: number;
}

export class TradeJournalService {
  private sql: ReturnType<typeof postgres> | null = null;

  constructor(private readonly botName: string) {}

  async initialize(): Promise<void> {
    if (!env.DATABASE_URL) {
      logger.warn('Trade journal disabled — DATABASE_URL not configured');
      return;
    }
    this.sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 2 });

    await this.sql`
      CREATE TABLE IF NOT EXISTS trades (
        id          SERIAL PRIMARY KEY,
        ticket      BIGINT NOT NULL UNIQUE,
        bybit_account VARCHAR(50),
        symbol      VARCHAR(20) NOT NULL,
        side        VARCHAR(4) NOT NULL,
        qty         FLOAT NOT NULL,
        entry_price FLOAT NOT NULL,
        stop_loss   FLOAT NOT NULL,
        take_profit FLOAT NOT NULL,
        planned_rr  FLOAT NOT NULL,
        risk_amount FLOAT NOT NULL,
        opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at   TIMESTAMPTZ,
        close_price FLOAT,
        profit      FLOAT,
        actual_rr   FLOAT,
        result      VARCHAR(10)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS trade_results (
        id           SERIAL PRIMARY KEY,
        owner_name   VARCHAR(100) NOT NULL,
        account_type VARCHAR(10)  NOT NULL,
        mt5_account  INTEGER      NOT NULL DEFAULT 0,
        bot_name     VARCHAR(50)  NOT NULL,
        symbol       VARCHAR(20)  NOT NULL,
        profit_usd   FLOAT        NOT NULL,
        direction    VARCHAR(5)   NOT NULL,
        closed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        closed_at_et VARCHAR(25)
      )
    `;

    await this.sql`ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS closed_at_et VARCHAR(25)`;

    logger.info('Trade journal initialized');
  }

  async recordOpen(entry: JournalEntry): Promise<void> {
    if (!this.sql) return;
    try {
      await this.sql`
        INSERT INTO trades
          (ticket, bybit_account, symbol, side, qty, entry_price, stop_loss, take_profit, planned_rr, risk_amount)
        VALUES
          (${entry.ticket}, ${entry.bybitAccount}, ${entry.symbol}, ${entry.side}, ${entry.qty},
           ${entry.entryPrice}, ${entry.stopLoss}, ${entry.takeProfit}, ${entry.plannedRr}, ${entry.riskAmount})
        ON CONFLICT (ticket) DO NOTHING
      `;
    } catch (err) {
      logger.warn({ err, ticket: entry.ticket }, 'Failed to record trade open');
    }
  }

  async recordClose(ticket: number, closePrice: number, profit: number): Promise<void> {
    if (!this.sql) return;
    try {
      const rows = await this.sql<{ side: string; entry_price: number; stop_loss: number; symbol: string }[]>`
        SELECT side, entry_price, stop_loss, symbol FROM trades WHERE ticket = ${ticket}
      `;
      if (!rows.length) return;

      const { side, entry_price, stop_loss, symbol } = rows[0];
      const slDistance = Math.abs(entry_price - stop_loss);
      const priceMove = side === 'BUY' ? closePrice - entry_price : entry_price - closePrice;
      const actualRr = slDistance > 0 ? Math.round((priceMove / slDistance) * 100) / 100 : 0;
      const result = Math.abs(actualRr) < 0.1 ? 'BE' : actualRr > 0 ? 'WIN' : 'LOSS';
      const closedAtEt = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace('T', ' ');

      await this.sql`
        UPDATE trades SET closed_at = NOW(), close_price = ${closePrice}, profit = ${profit},
          actual_rr = ${actualRr}, result = ${result} WHERE ticket = ${ticket}
      `;

      logger.info({ ticket, profit: profit.toFixed(2), result, rr: actualRr.toFixed(2) }, 'Trade closed');

      const cache = readLicenseCache();
      if (cache) {
        await this.sql`
          INSERT INTO trade_results
            (owner_name, account_type, mt5_account, bot_name, symbol, profit_usd, direction, closed_at_et)
          VALUES
            (${cache.owner_name}, ${cache.trade_mode}, 0,
             ${this.botName}, ${symbol}, ${profit}, ${side === 'BUY' ? 'LONG' : 'SHORT'}, ${closedAtEt})
        `;
      }
    } catch (err) {
      logger.warn({ err, ticket }, 'Failed to record trade close');
    }
  }

  async stop(): Promise<void> {
    if (this.sql) { await this.sql.end(); this.sql = null; }
  }
}
