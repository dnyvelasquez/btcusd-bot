import { subDays } from './date-utils';
import { fetchHistoricalCandles } from './bybit-history';
import { EMAEngine } from '@bot-core/strategy/indicators/ema-engine';
import { MACDEngine } from '@bot-core/strategy/indicators/macd-engine';
import { ADXEngine } from '@bot-core/strategy/indicators/adx-engine';
import type { Candle } from '@bybit/bybit.types';
import type { BacktestTrade, BacktestReport, BacktestMetrics, TradeResult, SignalType, BacktestParams, BlockedWindow } from './backtest.types';

const WARM_UP_DAYS = 7;
const MIN_QTY = 0.001;

// ── Sliding-window index ───────────────────────────────────────────────────────
// Instead of filter() on every bar (O(n²)), we keep a pointer per timeframe
// that only moves forward. getSlice(arr, idx, ts) advances idx until
// arr[idx].time >= ts, then returns arr.slice(0, idx). O(n) total.

class SlidingIndex {
  private idx = 0;
  constructor(private readonly arr: Candle[]) {}

  /** Returns all candles with time < ts (i.e. closed before current bar). */
  before(ts: number): Candle[] {
    while (this.idx < this.arr.length && this.arr[this.idx]!.time < ts) this.idx++;
    return this.arr.slice(0, this.idx);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isInWindow(cur: string, from: string, to: string): boolean {
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

function isSessionBlocked(ts: number, windows: BlockedWindow[]): boolean {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts * 1000));
  return windows.some(w => isInWindow(et, w.from, w.to));
}

function etDayOf(ts: number): string {
  return new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
}

function etHourOf(ts: number): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
      .format(new Date(ts * 1000)), 10,
  );
}

function etWeekdayOf(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
    .format(new Date(ts * 1000));
}

function isoET(ts: number): string {
  return new Date(ts * 1000)
    .toLocaleString('sv-SE', { timeZone: 'America/New_York' })
    .slice(0, 16).replace('T', ' ');
}

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

  const [m5All, m15All, h1All, h4All] = await Promise.all([
    fetchHistoricalCandles(params.symbol, 'M5',  warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'M15', warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'H1',  warmFrom, params.to),
    fetchHistoricalCandles(params.symbol, 'H4',  warmFrom, params.to),
  ]);

  console.log(`  M5:  ${m5All.length} candles`);
  console.log(`  M15: ${m15All.length} candles`);
  console.log(`  H1:  ${h1All.length} candles`);
  console.log(`  H4:  ${h4All.length} candles`);

  const fromTs = new Date(params.from).getTime() / 1000;
  const toTs   = new Date(params.to).getTime()   / 1000 + 86400;

  const m5Replay = m5All.filter(c => c.time >= fromTs && c.time < toTs);
  console.log(`\nReplaying ${m5Replay.length} M5 candles...\n`);

  // One sliding index per timeframe — each advances monotonically
  const m15Idx = new SlidingIndex(m15All);
  const h1Idx  = new SlidingIndex(h1All);
  const h4Idx  = new SlidingIndex(h4All);

  const ema  = new EMAEngine();
  const macd = new MACDEngine();
  const adx  = new ADXEngine();

  // State
  const trades: BacktestTrade[] = [];
  let balance       = params.initialBalance;
  let tradeNum      = 0;
  let openTrade: BacktestTrade | null = null;
  const lastSignalTime = new Map<string, number>();
  let consecLosses  = 0;
  let dailyLosses   = 0;
  let dailyLossDay  = '';
  let consecBadDays = 0;
  let pauseUntilMon = false;
  let dayOpenBal    = balance;
  let lastDay       = '';

  for (let i = 0; i < m5Replay.length; i++) {
    const bar = m5Replay[i]!;
    const ts  = bar.time;

    // ── Daily housekeeping ───────────────────────────────────────────────────
    const today = etDayOf(ts);
    if (today !== lastDay) {
      if (lastDay) {
        if (balance < dayOpenBal) {
          consecBadDays++;
          if (params.maxConsecLossDays > 0 && consecBadDays >= params.maxConsecLossDays) pauseUntilMon = true;
        } else { consecBadDays = 0; pauseUntilMon = false; }
      }
      dayOpenBal = balance;
      lastDay = today;
      if (etWeekdayOf(ts) === 'Mon') { consecBadDays = 0; pauseUntilMon = false; }
    }
    if (today !== dailyLossDay) { dailyLosses = 0; dailyLossDay = today; }

    // ── Manage open trade ────────────────────────────────────────────────────
    if (openTrade) {
      const slDist = Math.abs(openTrade.entry - openTrade.sl);

      // Trailing stop — advance SL as price moves in our favour
      if (params.trailRr > 0) {
        const trailDist = slDist * params.trailRr;
        const favourable = openTrade.side === 'BUY' ? bar.high - openTrade.entry : openTrade.entry - bar.low;
        if (favourable >= trailDist) {
          const candidate: number = openTrade.side === 'BUY'
            ? bar.close - trailDist
            : bar.close + trailDist;
          const improves = openTrade.side === 'BUY'
            ? candidate > openTrade.sl
            : candidate < openTrade.sl;
          if (improves) openTrade = Object.assign({}, openTrade, { sl: candidate });
        }
      }

      const hitSL = openTrade.side === 'BUY' ? bar.low  <= openTrade.sl : bar.high >= openTrade.sl;
      const hitTP = openTrade.side === 'BUY' ? bar.high >= openTrade.tp : bar.low  <= openTrade.tp;

      if (hitSL || hitTP) {
        const closePrice = (hitSL && hitTP) || hitSL ? openTrade.sl : openTrade.tp;
        const priceMove  = openTrade.side === 'BUY' ? closePrice - openTrade.entry : openTrade.entry - closePrice;
        const actualRr   = slDist > 0 ? priceMove / slDist : 0;
        const pnl        = priceMove * openTrade.qty;
        const result: TradeResult = hitTP && !hitSL ? 'WIN'
          : Math.abs(priceMove) < 1 ? 'BE' : 'LOSS';

        balance += pnl;
        if (result === 'LOSS') { consecLosses++; dailyLosses++; }
        else consecLosses = 0;

        trades.push({ ...openTrade, closeTime: ts, closeTimeISO: isoET(ts), actualRr, result, pnl });
        openTrade = null;
      }
      continue;
    }

    // ── Guards ───────────────────────────────────────────────────────────────
    if (pauseUntilMon) continue;
    if (isSessionBlocked(ts, params.blockedHours)) continue;
    if (params.maxConsecLosses > 0 && consecLosses >= params.maxConsecLosses) continue;
    if (params.maxDailyLosses  > 0 && dailyLosses  >= params.maxDailyLosses)  continue;

    const h = etHourOf(ts);
    if (params.epSkipMonday && etWeekdayOf(ts) === 'Mon') continue;
    if (params.epMinHour > 0 && h < params.epMinHour) continue;
    if (params.epMaxHour > 0 && h >= params.epMaxHour) continue;

    // ── Get candle slices via sliding index (O(1) amortised) ─────────────────
    const h1  = h1Idx.before(ts);
    const m15 = m15Idx.before(ts);
    const h4  = h4Idx.before(ts);

    if (h1.length < 40 || m15.length < 40) continue;

    const tpRr = params.tpRr ?? 2;

    // ── Signal evaluation ─────────────────────────────────────────────────────
    type SigResult = { direction: 'BULLISH' | 'BEARISH'; entry: number; sl: number; tp: number; signalType: SignalType };

    const evalEP = (): SigResult | null => {
      const h1Ema8  = ema.last(h1, 8);
      const h1Ema34 = ema.last(h1, 34);
      if (h1Ema8 === null || h1Ema34 === null) return null;

      const dir: 'BULLISH' | 'BEARISH' = h1Ema8 > h1Ema34 ? 'BULLISH' : 'BEARISH';
      if (params.emaSpreadMin > 0 && Math.abs(h1Ema8 - h1Ema34) < params.emaSpreadMin) return null;

      if (params.epH4Align && h4.length >= 40) {
        const h4e8  = ema.last(h4, 8);
        const h4e34 = ema.last(h4, 34);
        if (h4e8 === null || h4e34 === null) return null;
        if (dir === 'BULLISH' && h4e8 < h4e34) return null;
        if (dir === 'BEARISH' && h4e8 > h4e34) return null;
      }
      if (params.epAdxMin > 0 && h4.length >= 30) {
        const adxVal = adx.last(h4, params.epAdxPeriod);
        if (adxVal === null || adxVal < params.epAdxMin) return null;
      }
      if (params.epAdxMax > 0 && h4.length >= 30) {
        const adxVal = adx.last(h4, params.epAdxPeriod);
        if (adxVal !== null && adxVal > params.epAdxMax) return null;
      }

      const m15Ema34 = ema.last(m15, 34);
      if (m15Ema34 === null) return null;
      if (params.epM15Align) {
        const m15e8 = ema.last(m15, 8);
        if (m15e8 === null) return null;
        if (dir === 'BULLISH' && m15e8 < m15Ema34) return null;
        if (dir === 'BEARISH' && m15e8 > m15Ema34) return null;
      }

      const price = bar.close;
      if (Math.abs(price - m15Ema34) > params.zoneProximityPoints) return null;

      const macdResult = macd.analyze(m15);
      if (!macdResult) return null;
      if (dir === 'BULLISH' && macdResult.histogram <= 0) return null;
      if (dir === 'BEARISH' && macdResult.histogram >= 0) return null;

      const sl    = dir === 'BULLISH' ? m15Ema34 - params.zoneSlBufferPoints : m15Ema34 + params.zoneSlBufferPoints;
      const slDist = Math.abs(price - sl);
      if (params.minSlPoints > 0 && slDist < params.minSlPoints) return null;

      return { direction: dir, entry: price, sl, tp: dir === 'BULLISH' ? price + slDist * tpRr : price - slDist * tpRr, signalType: 'EMA_PB' };
    };

    const sig = evalEP();
    if (!sig) continue;

    // Cooldown
    const cooldownSecs = params.cooldownMinutes * 60;
    if (ts - (lastSignalTime.get(sig.direction) ?? 0) < cooldownSecs) continue;

    const qty = calcQty(balance, params.riskPercent, Math.abs(sig.entry - sig.sl), params.maxQty);
    lastSignalTime.set(sig.direction, ts);
    tradeNum++;

    openTrade = {
      tradeNumber:  tradeNum,
      signalType:   sig.signalType,
      direction:    sig.direction,
      side:         sig.direction === 'BULLISH' ? 'BUY' : 'SELL',
      openTime:     ts,
      closeTime:    null,
      openTimeISO:  isoET(ts),
      closeTimeISO: null,
      entry:        sig.entry,
      sl:           sig.sl,
      tp:           sig.tp,
      qty,
      plannedRr:    tpRr,
      actualRr:     null,
      result:       'OPEN',
      pnl:          0,
    };
  }

  if (openTrade) trades.push(openTrade);

  // ── Metrics ────────────────────────────────────────────────────────────────
  const closed      = trades.filter(t => t.result !== 'OPEN');
  const wins        = closed.filter(t => t.result === 'WIN');
  const losses      = closed.filter(t => t.result === 'LOSS');
  const bes         = closed.filter(t => t.result === 'BE');
  const totalPnl    = closed.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const allRrs      = closed.filter(t => t.actualRr !== null).map(t => t.actualRr!);
  const winRrs      = wins.map(t => t.actualRr ?? 0);
  const lossRrs     = losses.map(t => t.actualRr ?? 0);

  let peak = params.initialBalance, maxDD = 0, runBal = params.initialBalance;
  for (const t of closed) {
    runBal += t.pnl;
    if (runBal > peak) peak = runBal;
    const dd = (peak - runBal) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  let maxConsec = 0, curConsec = 0;
  for (const t of closed) {
    if (t.result === 'LOSS') { curConsec++; maxConsec = Math.max(maxConsec, curConsec); }
    else curConsec = 0;
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  const metrics: BacktestMetrics = {
    totalTrades:          trades.length,
    wins:                 wins.length,
    losses:               losses.length,
    breakevens:           bes.length,
    openTrades:           trades.filter(t => t.result === 'OPEN').length,
    winRate:              closed.length > 0 ? Math.round(wins.length / (wins.length + losses.length) * 1000) / 10 : 0,
    profitFactor:         grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : 999,
    avgRr:                Math.round(avg(allRrs) * 100) / 100,
    avgWinRr:             Math.round(avg(winRrs) * 100) / 100,
    avgLossRr:            Math.round(avg(lossRrs) * 100) / 100,
    totalPnl:             Math.round(totalPnl * 100) / 100,
    maxDrawdownPct:       Math.round(maxDD * 10000) / 100,
    maxConsecutiveLosses: maxConsec,
  };

  return {
    symbol:         params.symbol,
    from:           params.from,
    to:             params.to,
    initialBalance: params.initialBalance,
    finalBalance:   Math.round((params.initialBalance + totalPnl) * 100) / 100,
    riskPercent:    params.riskPercent,
    leverage:       params.leverage,
    cooldownMinutes: params.cooldownMinutes,
    metrics,
    trades,
    generatedAt:    new Date().toISOString(),
  };
}
