import type { Candle } from '@bybit/bybit.types';

export class EMAEngine {
  calc(candles: Candle[], period: number): number[] {
    if (candles.length < period) return [];
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    const result: number[] = [ema];
    for (let i = period; i < candles.length; i++) {
      ema = candles[i]!.close * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  last(candles: Candle[], period: number): number | null {
    const arr = this.calc(candles, period);
    return arr.length > 0 ? arr[arr.length - 1]! : null;
  }
}
