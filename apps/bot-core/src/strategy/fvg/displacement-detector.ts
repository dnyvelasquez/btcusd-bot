import type { Displacement } from './fvg-types';

interface C { time: number; open: number; high: number; low: number; close: number; }

export class DisplacementDetector {
  detect(candle: C): Displacement | null {
    const bodySize = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    if (range === 0 || bodySize / range < 0.6) return null;
    return {
      direction: candle.close > candle.open ? 'BULLISH' : 'BEARISH',
      candleTime: candle.time, bodySize, range, strength: bodySize / range,
    };
  }
}
