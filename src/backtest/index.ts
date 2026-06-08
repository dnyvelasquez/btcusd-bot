import fs from 'fs';
import path from 'path';

import { runBacktest } from './backtest-runner';
import type { BacktestReport, BacktestTrade } from './backtest.types';

// ── CLI arg parser ─────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--') && argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1]!; i++;
    } else if (arg.includes('=') && !arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      out[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  if (!out['start'] && positional[0]) out['start'] = positional[0]!;
  if (!out['end']   && positional[1]) out['end']   = positional[1]!;
  return out;
}

// ── Console report ─────────────────────────────────────────────────────────────
const SEP = '═'.repeat(80);
const sep = '─'.repeat(80);

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function tradeRow(t: BacktestTrade): string {
  const icon = t.result === 'WIN' ? '✓' : t.result === 'LOSS' ? '✗' : t.result === 'BE' ? '○' : '…';
  const pnl = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
  const rr = t.actualRr !== null ? t.actualRr.toFixed(2) : 'n/a';
  const tag = '[EP]';
  return [
    pad(t.tradeNumber, 3, true),
    pad(t.openTimeISO, 17),
    pad(tag, 5),
    pad(t.side, 5),
    pad(t.entry.toFixed(2), 10, true),
    pad(t.sl.toFixed(2), 10, true),
    pad(t.tp.toFixed(2), 10, true),
    pad(t.qty.toFixed(3), 7, true),
    pad(rr, 6, true),
    `${icon} ${pad(t.result, 5)}`,
    pad(pnl, 12, true),
  ].join('  ');
}

function printReport(r: BacktestReport): void {
  const m = r.metrics;
  const pnlSign = m.totalPnl >= 0 ? '+' : '';

  console.log('\n' + SEP);
  console.log(` BTC Bot — Backtest │ ${r.symbol}  ${r.from} → ${r.to}`);
  console.log(` Balance: $${r.initialBalance.toFixed(2)} → $${r.finalBalance.toFixed(2)}  │  Risk: ${r.riskPercent}%  │  Leverage: ${r.leverage}x  │  Cooldown: ${r.cooldownMinutes} min`);
  console.log(SEP);

  if (r.trades.length === 0) {
    console.log('\n  No trades in the selected period.\n');
  } else {
    console.log();
    console.log([
      pad('#', 3, true), pad('Apertura (ET)', 17), pad('Tipo', 5), pad('Dir', 5),
      pad('Entry', 10, true), pad('SL', 10, true), pad('TP', 10, true),
      pad('Qty', 7, true), pad('R:R', 6, true), pad('Resultado', 8),
      pad('P&L ($)', 12, true),
    ].join('  '));
    console.log(sep);
    for (const t of r.trades) console.log(tradeRow(t));
    console.log();
  }

  const ep = r.trades.filter(t => t.signalType === 'EMA_PB');
  const statLine = (label: string, ts: BacktestTrade[]) => {
    const w = ts.filter(t => t.result === 'WIN').length;
    const l = ts.filter(t => t.result === 'LOSS').length;
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    const wr = ts.length > 0 ? ((w / (w + l)) * 100).toFixed(1) : '-';
    return ` ${label}  trades=${ts.length}  W/L=${w}/${l}  WR=${wr}%  P&L=${(pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)}`;
  };

  console.log(SEP);
  console.log(' RESULTADOS');
  console.log(SEP);
  console.log(statLine('[EP] EMA Pullback:  ', ep));
  console.log(sep);
  console.log(` Total trades:          ${m.totalTrades}`);
  console.log(` Wins / Losses / BE:    ${m.wins} / ${m.losses} / ${m.breakevens}`);
  console.log(` Win rate:              ${m.winRate.toFixed(1)}%`);
  console.log(` Profit factor:         ${m.profitFactor === 999 ? '∞' : m.profitFactor.toFixed(2)}`);
  console.log(` Avg R:R (completadas): ${m.avgRr.toFixed(2)}`);
  console.log(` Avg R:R (wins):        ${m.avgWinRr.toFixed(2)}`);
  console.log(` Avg R:R (losses):      ${m.avgLossRr.toFixed(2)}`);
  console.log(` Total P&L:             ${pnlSign}$${m.totalPnl.toFixed(2)}`);
  console.log(` Max drawdown:          ${m.maxDrawdownPct.toFixed(2)}%`);
  console.log(` Max racha pérdidas:    ${m.maxConsecutiveLosses}`);
  console.log(SEP + '\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

  const from = args['start'] ?? args['from'];
  const to   = args['end']   ?? args['to'];

  if (!from || !to) {
    console.error('\nUso: npm run backtest -- --start YYYY-MM-DD --end YYYY-MM-DD\n');
    process.exit(1);
  }

  const report = await runBacktest({
    symbol:               args['symbol']        ?? (cfg['SYMBOL']                as string)  ?? 'BTCUSDT',
    from,
    to,
    initialBalance:       parseFloat(args['balance']     ?? '10000'),
    riskPercent:          parseFloat(args['risk']        ?? String(cfg['RISK_PERCENT']              ?? 1)),
    leverage:             parseInt(args['leverage']      ?? String(cfg['LEVERAGE']                  ?? 5), 10),
    maxQty:               parseFloat(args['max-qty']     ?? String(cfg['MAX_QTY']                   ?? 1)),
    cooldownMinutes:      parseInt(args['cooldown']      ?? String(cfg['SIGNAL_COOLDOWN_MINUTES']    ?? 60), 10),
    blockedHours:         (cfg['BLOCKED_HOURS'] as any) ?? [],
    zoneProximityPoints:  parseFloat(args['proximity']   ?? String(cfg['ZONE_PROXIMITY_POINTS']     ?? 500)),
    zoneSlBufferPoints:   parseFloat(args['sl-buffer']   ?? String(cfg['ZONE_SL_BUFFER_POINTS']     ?? 150)),
    minSlPoints:          parseFloat(args['min-sl']      ?? String(cfg['MIN_SL_POINTS']             ?? 0)),
    minFvgPoints:         parseFloat(args['min-fvg']     ?? String(cfg['MIN_FVG_POINTS']            ?? 0)),
    emaSpreadMin:         parseFloat(args['ema-spread']  ?? String(cfg['EMA_SPREAD_MIN']            ?? 0)),
    epH4Align:            (args['ep-h4-align']           ?? String(cfg['EP_H4_ALIGN']   ?? 'true'))  === 'true',
    epM15Align:           (args['ep-m15-align']          ?? String(cfg['EP_M15_ALIGN']  ?? 'false')) === 'true',
    epSkipMonday:         (args['ep-skip-monday']        ?? String(cfg['EP_SKIP_MONDAY']?? 'false')) === 'true',
    epMinHour:            parseInt(args['ep-min-hour']   ?? String(cfg['EP_MIN_HOUR']   ?? 8),  10),
    epMaxHour:            parseInt(args['ep-max-hour']   ?? String(cfg['EP_MAX_HOUR']   ?? 17), 10),
    epAdxMin:             parseFloat(args['ep-adx-min']  ?? String(cfg['EP_ADX_MIN']    ?? 0)),
    epAdxMax:             parseFloat(args['ep-adx-max']  ?? String(cfg['EP_ADX_MAX']    ?? 0)),
    epAdxPeriod:          parseInt(args['ep-adx-period'] ?? String(cfg['EP_ADX_PERIOD'] ?? 14), 10),
    ciMax:                parseFloat(args['ci-max']      ?? String(cfg['CI_MAX']        ?? 0)),
    maxConsecLosses:      parseInt(args['max-consec']    ?? String(cfg['MAX_CONSEC_LOSSES']      ?? 0),  10),
    maxDailyLosses:       parseInt(args['max-daily-l']   ?? String(cfg['MAX_DAILY_LOSSES']       ?? 0),  10),
    maxConsecLossDays:    parseInt(args['max-bad-days']  ?? String(cfg['MAX_CONSEC_LOSS_DAYS']   ?? 0),  10),
    trailRr:              parseFloat(args['trail-rr']    ?? String(cfg['TRAIL_RR']               ?? 1.5)),
    beAtPoints:           parseFloat(args['be-at']       ?? String(cfg['BE_AT_POINTS']           ?? 0)),
    beBuffer:             parseFloat(args['be-buffer']   ?? String(cfg['BE_BUFFER_POINTS']       ?? 50)),
    partialTpEnabled:     (args['partial-tp']            ?? String(cfg['PARTIAL_TP_ENABLED']     ?? 'false')) === 'true',
    tpRr:                 parseFloat(args['tp-rr']       ?? '2'),
  });

  printReport(report);

  const outFile = path.resolve(process.cwd(), `backtest-${report.symbol}-${from}-${to}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Reporte guardado en: ${outFile}\n`);
}

main().catch((err: unknown) => {
  console.error('Backtest falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
