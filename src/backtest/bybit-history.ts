import { RestClientV5, type KlineIntervalV3 } from 'bybit-api';

import { env } from '@config/env';
import type { Candle } from '../../src/services/bybit/bybit.types';

const TIMEFRAME_MAP: Record<string, KlineIntervalV3> = {
  M5: '5', M15: '15', H1: '60', H4: '240', D1: 'D',
};

export async function fetchHistoricalCandles(
  symbol: string,
  timeframe: string,
  fromDate: string,
  toDate: string,
): Promise<Candle[]> {
  const client = new RestClientV5({
    key: env.BYBIT_API_KEY,
    secret: env.BYBIT_API_SECRET,
    testnet: env.BYBIT_TESTNET,
  });

  const interval = TIMEFRAME_MAP[timeframe];
  if (!interval) throw new Error(`Unknown timeframe: ${timeframe}`);

  const fromMs = new Date(fromDate).getTime();
  const toMs   = new Date(toDate).getTime() + 86_400_000; // include full day

  const all: Candle[] = [];
  let cursor = toMs; // Bybit pagination: fetch backwards from `end`

  while (cursor > fromMs) {
    const res = await client.getKline({
      category: 'linear',
      symbol,
      interval,
      start: fromMs,
      end: cursor,
      limit: 1000,
    });

    if (res.retCode !== 0) throw new Error(`Bybit error: ${res.retMsg}`);
    if (!res.result.list.length) break;

    const batch: Candle[] = res.result.list.map(([time, open, high, low, close, volume]) => ({
      time: Math.floor(parseInt(time) / 1000),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      tick_volume: parseFloat(volume),
    }));

    // Bybit returns newest-first — the oldest candle in this batch is the last element
    const oldest = batch[batch.length - 1]!;
    all.push(...batch);

    // Move cursor before the oldest candle to get the next batch
    cursor = oldest.time * 1000 - 1;

    if (batch.length < 1000) break; // Last page
  }

  // De-duplicate and sort oldest-first
  const seen = new Set<number>();
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time)
    .filter(c => c.time >= fromMs / 1000 && c.time <= toMs / 1000);
}
