import type { FairValueGap } from './fvg-types';

interface C { time: number; high: number; low: number; }

export class FVGDetector {
  detectBullish(candles: C[]): FairValueGap | null {
    if (candles.length < 3) return null;
    const [first, middle, third] = candles;
    if (first!.high >= third!.low) return null;
    return { direction: 'BULLISH', startPrice: first!.high, endPrice: third!.low, candleTime: middle!.time, size: third!.low - first!.high };
  }

  detectBearish(candles: C[]): FairValueGap | null {
    if (candles.length < 3) return null;
    const [first, middle, third] = candles;
    if (first!.low <= third!.high) return null;
    return { direction: 'BEARISH', startPrice: third!.high, endPrice: first!.low, candleTime: middle!.time, size: first!.low - third!.high };
  }
}
