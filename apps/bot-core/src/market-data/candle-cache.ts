import type { Candle } from '@bybit/bybit.types';

export class CandleCache {
  private candles = new Map<string, Candle[]>();

  set(key: string, data: Candle[]): void { this.candles.set(key, data); }
  get(key: string): Candle[] { return this.candles.get(key) || []; }
}
