import fs from 'fs';
import path from 'path';

import express from 'express';
import postgres from 'postgres';

import { logger } from '../../src/infrastructure/logger/logger';

const STATIC_DIR  = path.resolve(__dirname, 'static');
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');
const STATUS_PATH = path.resolve(__dirname, '..', '..', 'bot-status.json');

function readConfig(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

function getDb(): ReturnType<typeof postgres> | null {
  const url = process.env['DATABASE_URL'];
  if (!url) return null;
  return postgres(url, { ssl: 'require', max: 2 });
}

export function startDashboard(port = 8002): void {
  const app = express();
  app.use(express.json());
  app.use(express.static(STATIC_DIR));

  // ── Bot status ────────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8'));
      const updated = new Date(data.updatedAt);
      const age = (Date.now() - updated.getTime()) / 1000;
      res.json({ available: age < 30, ...data, age: Math.round(age) });
    } catch {
      res.json({ available: false, ready: false, reason: 'Bot no disponible' });
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get('/api/settings', (_req, res) => res.json(readConfig()));

  app.put('/api/settings', (req, res) => {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf-8');
      res.json(req.body);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Journal stats ─────────────────────────────────────────────────────────
  app.get('/api/journal/stats', async (_req, res) => {
    const sql = getDb();
    if (!sql) return res.status(503).json({ error: 'DATABASE_URL not configured' });
    try {
      const [row] = await sql<{ total_closed: number; wins: number; losses: number; breakevens: number; open_trades: number; avg_rr: number | null; total_pnl: number | null; gross_profit: number; gross_loss: number }[]>`
        SELECT
          COUNT(*)    FILTER (WHERE closed_at IS NOT NULL)                            AS total_closed,
          COUNT(*)    FILTER (WHERE result = 'WIN')                                   AS wins,
          COUNT(*)    FILTER (WHERE result = 'LOSS')                                  AS losses,
          COUNT(*)    FILTER (WHERE result = 'BE')                                    AS breakevens,
          COUNT(*)    FILTER (WHERE closed_at IS NULL)                                AS open_trades,
          ROUND(AVG(actual_rr)   FILTER (WHERE closed_at IS NOT NULL)::numeric, 2)   AS avg_rr,
          ROUND(SUM(profit)      FILTER (WHERE closed_at IS NOT NULL)::numeric, 2)   AS total_pnl,
          COALESCE(SUM(profit)   FILTER (WHERE profit > 0 AND closed_at IS NOT NULL), 0) AS gross_profit,
          COALESCE(ABS(SUM(profit) FILTER (WHERE profit < 0 AND closed_at IS NOT NULL)), 0) AS gross_loss
        FROM trades
      `;

      const total   = Number(row.total_closed) || 0;
      const wins    = Number(row.wins) || 0;
      const losses  = Number(row.losses) || 0;
      const gp      = Number(row.gross_profit);
      const gl      = Number(row.gross_loss);

      // Loss streak
      const results = await sql<{ result: string }[]>`
        SELECT result FROM trades WHERE closed_at IS NOT NULL ORDER BY closed_at ASC
      `;
      let maxStreak = 0, curStreak = 0;
      for (const r of results) {
        if (r.result === 'LOSS') { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
        else curStreak = 0;
      }

      await sql.end();
      res.json({
        success: true,
        data: {
          total_closed: total,
          wins,
          losses,
          breakevens: Number(row.breakevens) || 0,
          open_trades: Number(row.open_trades) || 0,
          win_rate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
          avg_rr: row.avg_rr !== null ? Number(row.avg_rr) : null,
          total_pnl: row.total_pnl !== null ? Number(row.total_pnl) : 0,
          profit_factor: gl > 0 ? Math.round((gp / gl) * 100) / 100 : null,
          max_loss_streak: maxStreak,
          current_loss_streak: curStreak,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Journal trades ────────────────────────────────────────────────────────
  app.get('/api/journal/trades', async (req, res) => {
    const sql = getDb();
    if (!sql) return res.status(503).json({ error: 'DATABASE_URL not configured' });
    const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10), 200);
    try {
      const rows = await sql`
        SELECT id, ticket, symbol, side, qty, entry_price, stop_loss, take_profit,
               planned_rr, risk_amount, opened_at, closed_at, close_price, profit, actual_rr, result
        FROM trades ORDER BY opened_at DESC LIMIT ${limit}
      `;
      await sql.end();
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────
  app.get('*', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

  app.listen(port, '127.0.0.1', () => {
    logger.info(`Dashboard running → http://localhost:${port}`);
  });
}
