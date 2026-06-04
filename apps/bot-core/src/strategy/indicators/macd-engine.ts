import type { Candle } from '@bybit/bybit.types';
import { EMAEngine } from './ema-engine';

export interface MACDResult { macdLine: number; signalLine: number; histogram: number; }

export class MACDEngine {
  private readonly ema = new EMAEngine();

  analyze(candles: Candle[], fast = 12, slow = 26, signal = 9): MACDResult | null {
    if (candles.length < slow + signal) return null;
    const fastEMAs = this.ema.calc(candles, fast);
    const slowEMAs = this.ema.calc(candles, slow);
    const offset = slow - fast;
    const macdLine: number[] = [];
    for (let i = 0; i < slowEMAs.length; i++) macdLine.push(fastEMAs[i + offset]! - slowEMAs[i]!);
    if (macdLine.length < signal) return null;
    const k = 2 / (signal + 1);
    let signalEMA = macdLine.slice(0, signal).reduce((s, v) => s + v, 0) / signal;
    for (let i = signal; i < macdLine.length; i++) signalEMA = macdLine[i]! * k + signalEMA * (1 - k);
    const last = macdLine[macdLine.length - 1]!;
    return { macdLine: last, signalLine: signalEMA, histogram: last - signalEMA };
  }
}
