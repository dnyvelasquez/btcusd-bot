import { subDays } from './date-utils';
import { fetchHistoricalCandles } from './bybit-history';
import { EMAEngine } from '@bot-core/strategy/indicators/ema-engine';
import { MACDEngine } from '@bot-core/strategy/indicators/macd-engine';
import { ADXEngine } from '@bot-core/strategy/indicators/adx-engine';
import { FVGDetector } from '@bot-core/strategy/fvg/fvg-detector';
import { DisplacementDetector } from '@bot-core/strategy/fvg/displacement-detector';
import type { Candle } from '@bybit/bybit.types';
import type { BacktestTrade, BacktestReport, BacktestMetrics, TradeResult, BacktestParams, BlockedWindow } from './backtest.types';

const WARM_UP_DAYS = 7;
const MAX_LOOKAHEAD = 500;
const MIN_QTY = 0.001;

// ── Helpers ────────────────────────────────────────────────────────────────────

function isInWindow(current: string, from: string, to: string): boolean {
  if (from <= to) return current >= from && current < to;
  return current >= from || current < to;
}

function isSessionBlocked(ts: number, windows: BlockedWindow[]): boolean {
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts * 1000));
  return windows.some(w => isInWindow(et, w.from, w.to));
}

function etDayOf(ts: number): string {
  return new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
}

function etHourOf(ts: number): number {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(ts * 1000)), 10);
}

function etWeekdayOf(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ts * 1000));
}

function isoET(ts: number): string {
  return new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16).replace('T', ' ');
}

// BTC sizing: qty = riskUSD / slDistanceUSD
function calcQty(balance: number, riskPct: number, slDist: number, maxQty: number): number {
  const riskUSD = balance * (riskPct / 100);
  const raw = slDist > 0 ? riskUSD / slDist : MIN_QTY;
  const steps = Math.max(1, Math.round(raw / MIN_QTY));
  return Math.min(maxQty, steps * MIN_QTY);
}

// ── Main runner ────────────────────────────────────────────────────────────────

export async function runBacktest(params: BacktestParams): Promise<BacktestReport> {
  const warmFrom = subDays(params.from, WARM_UP_DAYS);

  console.log(`\nFetching candles for ${params.symbol}  (${warmFrom} → ${params.to})...`);

  const [m5All, m15All, h1All, h4All, d1All] = await Promise.all([
    fetchHistoricalCandles(params.symbol, 'M5',  warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'M15', warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'H1',  warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'H4',  warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'D1',  warmFrom, params.to),
  ]);

  console.log(`  M5:  ${m5All.length} candles`);
  console.log(`  M15: ${m15All.length} candles`);
  console.log(`  H1:  ${h1All.length} candles`);
  console.log(`  H4:  ${h4All.length} candles`);
  console.log(`  D1:  ${d1All.length} candles`);

  const fromTs = new Date(params.from).getTime() / 1000;
  const toTs   = new Date(params.to).getTime() / 1000 + 86400;

  // Only replay candles within the requested range
  const m5Replay = m5All.filter(c => c.time >= fromTs && c.time < toTs);
  console.log(`\nReplaying ${m5Replay.length} M5 candles...\n`);

  const ema = new EMAEngine();
  const macd = new MACDEngine();
  const adx = new ADXEngine();
  const fvg = new FVGDetector();
  const disp = new DisplacementDetector();

  // State
  const trades: BacktestTrade[] = [];
  let balance = params.initialBalance;
  let tradeNum = 0;
  let openTrade: BacktestTrade | null = null;
  const lastSignalTime = new Map<string, number>();
  let consecLosses = 0;
  let dailyLosses = 0;
  let dailyLossesDay = '';
  let consecBadDays = 0;
  let pauseUntilMon = false;
  let dayOpenBalance = balance;
  let lastDay = '';

  const candlesBefore = (arr: Candle[], ts: number): Candle[] => arr.filter(c => c.time < ts);

  for (let i = 0; i < m5Replay.length; i++) {
    const bar = m5Replay[i]!;
    const ts = bar.time;

    // Daily reset
    const today = etDayOf(ts);
    if (today !== lastDay) {
      if (lastDay && dayOpenBalance > 0) {
        if (balance < dayOpenBalance) {
          consecBadDays++;
          if (params.maxConsecLossDays > 0 && consecBadDays >= params.maxConsecLossDays) pauseUntilMon = true;
        } else { consecBadDays = 0; pauseUntilMon = false; }
      }
      dayOpenBalance = balance;
      lastDay = today;
      if (etWeekdayOf(ts) === 'Mon') { consecBadDays = 0; pauseUntilMon = false; }
    }

    const todayET = etDayOf(ts);
    if (todayET !== dailyLossesDay) { dailyLosses = 0; dailyLossesDay = todayET; }

    // ── Manage open trade ────────────────────────────────────────────────────
    if (openTrade) {
      const slDist = Math.abs(openTrade.entry - openTrade.sl);

      // Trailing stop
      let updatedSL: number = openTrade.sl;
      if (params.trailRr > 0) {
        const trailDist = slDist * params.trailRr;
        const profit = openTrade.side === 'BUY' ? bar.high - openTrade.entry : openTrade.entry - bar.low;
        if (profit >= slDist * params.trailRr) {
          const candidate = openTrade.side === 'BUY' ? bar.close - trailDist : bar.close + trailDist;
          const improves = openTrade.side === 'BUY' ? candidate > updatedSL : candidate < updatedSL;
          if (improves) updatedSL = candidate;
        }
      }
      if (updatedSL !== openTrade.sl) openTrade = Object.assign({}, openTrade, { sl: updatedSL });

      // Check if SL or TP hit
      const hitSL = openTrade.side === 'BUY' ? bar.low <= openTrade.sl : bar.high >= openTrade.sl;
      const hitTP = openTrade.side === 'BUY' ? bar.high >= openTrade.tp : bar.low <= openTrade.tp;

      if (hitSL || hitTP) {
        let closePrice: number;
        let result: TradeResult;

        if (hitSL && hitTP) {
          // Both in same candle — assume SL first (pessimistic)
          closePrice = openTrade.sl;
          result = 'LOSS';
        } else if (hitTP) {
          closePrice = openTrade.tp;
          result = 'WIN';
        } else {
          closePrice = openTrade.sl;
          const pnl = openTrade.side === 'BUY' ? closePrice - openTrade.entry : openTrade.entry - closePrice;
          result = Math.abs(pnl) < 1 ? 'BE' : pnl > 0 ? 'WIN' : 'LOSS';
        }

        const priceMove = openTrade.side === 'BUY' ? closePrice - openTrade.entry : openTrade.entry - closePrice;
        const actualRr = slDist > 0 ? priceMove / slDist : 0;
        const pnl = priceMove * openTrade.qty;

        balance += pnl;
        if (result === 'LOSS') { consecLosses++; dailyLosses++; }
        else { consecLosses = 0; }

        const closed: BacktestTrade = { ...openTrade, closeTime: ts, closeTimeISO: isoET(ts), actualRr, result, pnl };
        trades.push(closed);
        openTrade = null;
      }
      continue; // One position at a time
    }

    // ── Guards ───────────────────────────────────────────────────────────────
    if (pauseUntilMon) continue;
    if (isSessionBlocked(ts, params.blockedHours)) continue;
    if (params.maxConsecLosses > 0 && consecLosses >= params.maxConsecLosses) continue;
    if (params.maxDailyLosses > 0 && dailyLosses >= params.maxDailyLosses) continue;

    // ── EMA Pullback signal ───────────────────────────────────────────────────
    const h = etHourOf(ts);
    if (params.epSkipMonday && etWeekdayOf(ts) === 'Mon') continue;
    if (params.epMinHour > 0 && h < params.epMinHour) continue;
    if (params.epMaxHour > 0 && h >= params.epMaxHour) continue;

    const h1 = candlesBefore(h1All, ts);
    const m15 = candlesBefore(m15All, ts);
    const h4 = candlesBefore(h4All, ts);

    if (h1.length < 40 || m15.length < 40) continue;

    const h1Ema8 = ema.last(h1, 8);
    const h1Ema34 = ema.last(h1, 34);
    if (h1Ema8 === null || h1Ema34 === null) continue;

    const direction: 'BULLISH' | 'BEARISH' = h1Ema8 > h1Ema34 ? 'BULLISH' : 'BEARISH';
    if (params.emaSpreadMin > 0 && Math.abs(h1Ema8 - h1Ema34) < params.emaSpreadMin) continue;

    if (params.epH4Align && h4.length >= 40) {
      const h4e8 = ema.last(h4, 8), h4e34 = ema.last(h4, 34);
      if (h4e8 === null || h4e34 === null) continue;
      if (direction === 'BULLISH' && h4e8 < h4e34) continue;
      if (direction === 'BEARISH' && h4e8 > h4e34) continue;
    }

    if (params.epAdxMin > 0 && h4.length >= 30) {
      const adxVal = adx.last(h4, params.epAdxPeriod);
      if (adxVal === null || adxVal < params.epAdxMin) continue;
    }
    if (params.epAdxMax > 0 && h4.length >= 30) {
      const adxVal = adx.last(h4, params.epAdxPeriod);
      if (adxVal !== null && adxVal > params.epAdxMax) continue;
    }

    const m15Ema34 = ema.last(m15, 34);
    if (m15Ema34 === null) continue;

    if (params.epM15Align) {
      const m15e8 = ema.last(m15, 8);
      if (m15e8 === null) continue;
      if (direction === 'BULLISH' && m15e8 < m15Ema34) continue;
      if (direction === 'BEARISH' && m15e8 > m15Ema34) continue;
    }

    const currentPrice = bar.close;
    if (Math.abs(currentPrice - m15Ema34) > params.zoneProximityPoints) continue;

    const macdResult = macd.analyze(m15);
    if (!macdResult) continue;
    if (direction === 'BULLISH' && macdResult.histogram <= 0) continue;
    if (direction === 'BEARISH' && macdResult.histogram >= 0) continue;

    // Cooldown
    const cooldownMs = params.cooldownMinutes * 60;
    const lastSig = lastSignalTime.get(direction) ?? 0;
    if (ts - lastSig < cooldownMs) continue;

    // Levels
    const entryPrice = currentPrice;
    const stopLoss = direction === 'BULLISH'
      ? m15Ema34 - params.zoneSlBufferPoints
      : m15Ema34 + params.zoneSlBufferPoints;
    const slDist = Math.abs(entryPrice - stopLoss);

    if (params.minSlPoints > 0 && slDist < params.minSlPoints) continue;

    const tpRr = params.tpRr ?? 2;
    const takeProfit = direction === 'BULLISH'
      ? entryPrice + slDist * tpRr
      : entryPrice - slDist * tpRr;

    const plannedRr = tpRr;
    const qty = calcQty(balance, params.riskPercent, slDist, params.maxQty);
    const pnl0 = 0;

    lastSignalTime.set(direction, ts);
    tradeNum++;

    openTrade = {
      tradeNumber: tradeNum,
      direction,
      side: direction === 'BULLISH' ? 'BUY' : 'SELL',
      openTime: ts,
      closeTime: null,
      openTimeISO: isoET(ts),
      closeTimeISO: null,
      entry: entryPrice,
      sl: stopLoss,
      tp: takeProfit,
      qty,
      plannedRr,
      actualRr: null,
      result: 'OPEN',
      pnl: pnl0,
    };
  }

  // Close any open trade at end
  if (openTrade) trades.push(openTrade);

  // ── Metrics ────────────────────────────────────────────────────────────────
  const closed = trades.filter(t => t.result !== 'OPEN');
  const wins = closed.filter(t => t.result === 'WIN');
  const losses = closed.filter(t => t.result === 'LOSS');
  const bes = closed.filter(t => t.result === 'BE');
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRrs = wins.map(t => t.actualRr ?? 0);
  const lossRrs = losses.map(t => t.actualRr ?? 0);
  const allRrs = closed.filter(t => t.actualRr !== null).map(t => t.actualRr!);

  // Max drawdown
  let peak = params.initialBalance, maxDD = 0, runBalance = params.initialBalance;
  for (const t of closed) {
    runBalance += t.pnl;
    if (runBalance > peak) peak = runBalance;
    const dd = (peak - runBalance) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Max consecutive losses
  let maxConsec = 0, curConsec = 0;
  for (const t of closed) {
    if (t.result === 'LOSS') { curConsec++; maxConsec = Math.max(maxConsec, curConsec); }
    else curConsec = 0;
  }

  const metrics: BacktestMetrics = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: bes.length,
    openTrades: trades.filter(t => t.result === 'OPEN').length,
    winRate: closed.length > 0 ? Math.round((wins.length / (wins.length + losses.length)) * 1000) / 10 : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : 999,
    avgRr: allRrs.length > 0 ? Math.round(allRrs.reduce((s, v) => s + v, 0) / allRrs.length * 100) / 100 : 0,
    avgWinRr: winRrs.length > 0 ? Math.round(winRrs.reduce((s, v) => s + v, 0) / winRrs.length * 100) / 100 : 0,
    avgLossRr: lossRrs.length > 0 ? Math.round(lossRrs.reduce((s, v) => s + v, 0) / lossRrs.length * 100) / 100 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    maxConsecutiveLosses: maxConsec,
  };

  return {
    symbol: params.symbol,
    from: params.from,
    to: params.to,
    initialBalance: params.initialBalance,
    finalBalance: Math.round((params.initialBalance + totalPnl) * 100) / 100,
    riskPercent: params.riskPercent,
    leverage: params.leverage,
    cooldownMinutes: params.cooldownMinutes,
    metrics,
    trades,
    generatedAt: new Date().toISOString(),
  };
}
