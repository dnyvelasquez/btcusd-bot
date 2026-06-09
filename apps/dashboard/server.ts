import fs from 'fs';
import path from 'path';

import express from 'express';
import postgres from 'postgres';
import { RestClientV5 } from 'bybit-api';

import { logger } from '../../src/infrastructure/logger/logger';

const STATIC_DIR  = path.resolve(__dirname, 'static');
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');
const STATUS_PATH = path.resolve(__dirname, '..', '..', 'bot-status.json');
const CACHE_PATH  = path.resolve(__dirname, '..', '..', 'license-cache.json');
const ENV_PATH    = path.resolve(__dirname, '..', '..', '.env');

function readConfig(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    fs.readFileSync(ENV_PATH, 'utf-8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]!] = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
    });
  } catch {}
  return out;
}

function writeEnvKey(key: string, value: string): void {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf-8'); } catch {}
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, `${key}=${value}`) : content + `\n${key}=${value}`;
  fs.writeFileSync(ENV_PATH, content, 'utf-8');
}

function getDb(): ReturnType<typeof postgres> | null {
  const url = process.env['DATABASE_URL'];
  return url ? postgres(url, { ssl: 'require', max: 2 }) : null;
}

export function startDashboard(port = 8002): void {
  const app = express();
  app.use(express.json());
  app.use(express.static(STATIC_DIR));

  // ── Bybit health ──────────────────────────────────────────────────────────
  app.get('/api/trading/health', async (_req, res) => {
    try {
      const testnet = process.env['BYBIT_TESTNET'] === 'true';
      const base = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
      const r = await fetch(`${base}/v5/market/time`);
      const d = await r.json() as { retCode: number };
      res.json({ success: d.retCode === 0, bybit_connected: d.retCode === 0 });
    } catch {
      res.json({ success: false, bybit_connected: false });
    }
  });

  // ── Bot status ────────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8'));
      const age = (Date.now() - new Date(data.updatedAt).getTime()) / 1000;
      if (age > 30) return res.json({ available: false, ready: false, reason: 'Bot sin actividad reciente', age: Math.round(age) });
      res.json({ available: true, ...data, age: Math.round(age) });
    } catch {
      res.json({ available: false, ready: false, reason: 'Bot no disponible' });
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  // Only operational keys are editable from the dashboard. Strategy/risk params
  // validated in backtests stay in config.json and are preserved on save.
  const EDITABLE_KEYS = ['RISK_PERCENT', 'LIVE_TRADING', 'TELEGRAM_ENABLED', 'LICENSE_KEY'];

  app.get('/api/settings', (_req, res) => res.json(readConfig()));

  app.put('/api/settings', (req, res) => {
    try {
      const existing = readConfig();
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const k of EDITABLE_KEYS) {
        if (k in body) existing[k] = body[k];
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2), 'utf-8');
      res.json(existing);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── License ───────────────────────────────────────────────────────────────
  app.get('/api/license', (_req, res) => {
    if (!fs.existsSync(CACHE_PATH)) return res.status(404).json({ detail: 'License not cached yet — start the bot first' });
    try { res.json(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))); }
    catch (err) { res.status(500).json({ detail: String(err) }); }
  });

  const LICENSE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  app.post('/api/license/validate', async (req, res) => {
    const { license_key } = (req.body ?? {}) as { license_key?: string };
    if (!license_key || !LICENSE_KEY_RE.test(license_key)) {
      return res.json({ valid: false, reason: 'Formato de clave inválido' });
    }

    const dbUrl = process.env['DATABASE_URL'];
    if (!dbUrl) return res.status(503).json({ valid: false, reason: 'DATABASE_URL no configurado' });

    const env = readEnv();
    const apiKey = env['BYBIT_API_KEY'], apiSecret = env['BYBIT_API_SECRET'];
    const testnet = env['BYBIT_TESTNET'] !== 'false';
    if (!apiKey || !apiSecret) return res.json({ valid: false, reason: 'Credenciales de Bybit no configuradas' });

    let uid: number;
    try {
      const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet });
      const r = await client.getQueryApiKey();
      if (r.retCode !== 0) return res.json({ valid: false, reason: `No se pudo conectar a Bybit: ${r.retMsg}` });
      uid = r.result.userID;
    } catch (err) {
      const detail = (err as { message?: string } | null)?.message ?? String(err);
      return res.json({ valid: false, reason: `No se pudo conectar a Bybit: ${detail}` });
    }
    const tradeMode: 'DEMO' | 'REAL' = testnet ? 'DEMO' : 'REAL';

    const sql = postgres(dbUrl, { ssl: 'require', max: 1, connect_timeout: 5 });
    try {
      const rows = await sql<{ owner_name: string; mt5_account: number; allowed_mode: 'demo' | 'live' | 'both'; active: boolean; expires_at: string | null }[]>`
        SELECT owner_name, mt5_account, allowed_mode, active, expires_at
        FROM licenses WHERE license_key = ${license_key}::uuid LIMIT 1
      `;
      if (!rows.length) return res.json({ valid: false, reason: 'Clave de licencia no encontrada' });

      const license = rows[0];
      if (!license.active) return res.json({ valid: false, reason: 'La licencia está inactiva' });
      if (license.expires_at && new Date(license.expires_at) < new Date()) {
        return res.json({ valid: false, reason: `La licencia venció el ${new Date(license.expires_at).toISOString().slice(0, 10)}` });
      }
      if (Number(license.mt5_account) !== uid) {
        return res.json({ valid: false, reason: `Cuenta incorrecta — la licencia es para la cuenta ${license.mt5_account}, conectada: ${uid}` });
      }

      const isDemo = tradeMode === 'DEMO';
      const modeOk = license.allowed_mode === 'both'
        || (license.allowed_mode === 'demo' && isDemo)
        || (license.allowed_mode === 'live' && !isDemo);
      if (!modeOk) {
        return res.json({ valid: false, reason: `La licencia solo permite modo '${license.allowed_mode}', cuenta actual: ${tradeMode}` });
      }

      const cfg = readConfig();
      cfg['LICENSE_KEY'] = license_key;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');

      const expiresStr = license.expires_at ? new Date(license.expires_at).toISOString() : null;
      fs.writeFileSync(CACHE_PATH, JSON.stringify({
        owner_name: license.owner_name,
        mt5_account: uid,
        trade_mode: tradeMode,
        allowed_mode: license.allowed_mode,
        active: license.active,
        expires_at: expiresStr,
        validated_at: new Date().toISOString(),
      }, null, 2), 'utf-8');

      res.json({ valid: true, owner_name: license.owner_name, mt5_account: uid, allowed_mode: license.allowed_mode, expires_at: expiresStr });
    } catch (err) {
      res.status(500).json({ valid: false, reason: String(err) });
    } finally {
      await sql.end({ timeout: 3 });
    }
  });

  // ── Bybit credentials ─────────────────────────────────────────────────────
  app.get('/api/bybit', async (_req, res) => {
    const env = readEnv();
    const api_key = env['BYBIT_API_KEY'] ?? '';
    const api_secret = env['BYBIT_API_SECRET'] ?? '';
    const testnet = env['BYBIT_TESTNET'] !== 'false';

    let uid: number | null = null;
    if (api_key && api_secret) {
      try {
        const client = new RestClientV5({ key: api_key, secret: api_secret, testnet });
        const r = await client.getQueryApiKey();
        if (r.retCode === 0) uid = r.result.userID;
      } catch { /* shown as unavailable below */ }
    }

    res.json({ api_key, api_secret, testnet, uid });
  });

  app.put('/api/bybit', (req, res) => {
    const { api_key, api_secret, testnet } = req.body as { api_key: string; api_secret: string; testnet: boolean };
    if (!api_key || !api_secret) return res.status(400).json({ detail: 'API Key y Secret no pueden estar vacíos' });
    writeEnvKey('BYBIT_API_KEY', api_key);
    writeEnvKey('BYBIT_API_SECRET', api_secret);
    writeEnvKey('BYBIT_TESTNET', testnet ? 'true' : 'false');
    res.json({ api_key, api_secret, testnet });
  });

  app.post('/api/bybit/test', async (req, res) => {
    const body = (req.body ?? {}) as { api_key?: string; api_secret?: string; testnet?: boolean };
    const env = readEnv();
    const key      = body.api_key?.trim()    || env['BYBIT_API_KEY'];
    const secret   = body.api_secret?.trim() || env['BYBIT_API_SECRET'];
    const testnet  = body.testnet ?? (env['BYBIT_TESTNET'] !== 'false');
    if (!key || !secret) return res.json({ success: false, detail: 'API Key o Secret no configurados' });
    try {
      const client = new RestClientV5({ key, secret, testnet });
      const r = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
      if (r.retCode !== 0) return res.json({ success: false, detail: r.retMsg });
      res.json({ success: true, detail: `Conexión OK — cuenta ${testnet ? 'demo (testnet)' : 'real'}` });
    } catch (err) {
      const detail = (err as { message?: string } | null)?.message ?? String(err);
      res.json({ success: false, detail });
    }
  });

  // ── Telegram ──────────────────────────────────────────────────────────────
  app.get('/api/telegram', (_req, res) => {
    const env = readEnv();
    res.json({ token: env['TELEGRAM_BOT_TOKEN'] ?? '', chat_id: env['TELEGRAM_CHAT_ID'] ?? '' });
  });

  app.put('/api/telegram', (req, res) => {
    const { token, chat_id } = req.body as { token: string; chat_id: string };
    if (!token) return res.status(400).json({ detail: 'El token no puede estar vacío' });
    writeEnvKey('TELEGRAM_BOT_TOKEN', token);
    writeEnvKey('TELEGRAM_CHAT_ID', chat_id ?? '');
    res.json({ token, chat_id });
  });

  app.post('/api/telegram/test', async (_req, res) => {
    const env = readEnv();
    const token = env['TELEGRAM_BOT_TOKEN'], chatId = env['TELEGRAM_CHAT_ID'];
    if (!token || !chatId) return res.json({ success: false, detail: 'Token o Chat ID no configurados' });
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '🤖 BTC Bot — prueba de conexión Telegram exitosa' }),
      });
      const d = await r.json() as { ok: boolean; description?: string };
      res.json({ success: d.ok, detail: d.ok ? 'Mensaje enviado' : (d.description ?? 'Error') });
    } catch (err) { res.json({ success: false, detail: String(err) }); }
  });

  const SYMBOL = 'BTCUSDT';

  // ── Journal stats ─────────────────────────────────────────────────────────
  app.get('/api/journal/stats', async (_req, res) => {
    const sql = getDb();
    if (!sql) return res.status(503).json({ error: 'DATABASE_URL not configured' });
    try {
      const [row] = await sql<{ total_closed: number; wins: number; losses: number; breakevens: number; open_trades: number; avg_rr: number | null; total_pnl: number | null; gross_profit: number; gross_loss: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE closed_at IS NOT NULL) AS total_closed,
          COUNT(*) FILTER (WHERE result = 'WIN')        AS wins,
          COUNT(*) FILTER (WHERE result = 'LOSS')       AS losses,
          COUNT(*) FILTER (WHERE result = 'BE')         AS breakevens,
          COUNT(*) FILTER (WHERE closed_at IS NULL)     AS open_trades,
          ROUND(AVG(actual_rr)  FILTER (WHERE closed_at IS NOT NULL)::numeric, 2) AS avg_rr,
          ROUND(SUM(profit)     FILTER (WHERE closed_at IS NOT NULL)::numeric, 2) AS total_pnl,
          COALESCE(SUM(profit)  FILTER (WHERE profit > 0 AND closed_at IS NOT NULL), 0)          AS gross_profit,
          COALESCE(ABS(SUM(profit) FILTER (WHERE profit < 0 AND closed_at IS NOT NULL)), 0)      AS gross_loss
        FROM trades
        WHERE symbol = ${SYMBOL}
      `;
      const total = Number(row.total_closed) || 0, wins = Number(row.wins) || 0;
      const gp = Number(row.gross_profit), gl = Number(row.gross_loss);
      const results = await sql<{ result: string }[]>`SELECT result FROM trades WHERE closed_at IS NOT NULL AND symbol = ${SYMBOL} ORDER BY closed_at ASC`;
      let maxStreak = 0, curStreak = 0;
      for (const r of results) {
        if (r.result === 'LOSS') { curStreak++; maxStreak = Math.max(maxStreak, curStreak); } else curStreak = 0;
      }
      await sql.end();
      res.json({ success: true, data: {
        total_closed: total, wins, losses: Number(row.losses) || 0, breakevens: Number(row.breakevens) || 0,
        open_trades: Number(row.open_trades) || 0,
        win_rate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
        avg_rr: row.avg_rr !== null ? Number(row.avg_rr) : null,
        total_pnl: row.total_pnl !== null ? Number(row.total_pnl) : 0,
        profit_factor: gl > 0 ? Math.round((gp / gl) * 100) / 100 : null,
        max_loss_streak: maxStreak, current_loss_streak: curStreak,
      }});
    } catch (err) { res.status(500).json({ error: String(err) }); }
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
        FROM trades WHERE symbol = ${SYMBOL} ORDER BY opened_at DESC LIMIT ${limit}
      `;
      await sql.end();
      res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.delete('/api/journal/trades', async (_req, res) => {
    const sql = getDb();
    if (!sql) return res.status(503).json({ error: 'DATABASE_URL not configured' });
    try {
      await sql`TRUNCATE TABLE trades RESTART IDENTITY`;
      await sql.end();
      res.json({ success: true, message: 'Journal cleared' });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('*', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

  app.listen(port, '127.0.0.1', () => logger.info(`Dashboard → http://localhost:${port}`));
}
