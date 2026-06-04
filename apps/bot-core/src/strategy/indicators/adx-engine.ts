import type { Candle } from '@bybit/bybit.types';

export class ADXEngine {
  private wilderSum(data: number[], period: number): number[] {
    if (data.length < period) return [];
    const result: number[] = [];
    let s = data.slice(0, period).reduce((a, v) => a + v, 0);
    result.push(s);
    for (let i = period; i < data.length; i++) { s = s - s / period + data[i]!; result.push(s); }
    return result;
  }

  private wilderAvg(data: number[], period: number): number[] {
    if (data.length < period) return [];
    const result: number[] = [];
    let s = data.slice(0, period).reduce((a, v) => a + v, 0) / period;
    result.push(s);
    for (let i = period; i < data.length; i++) { s = (s * (period - 1) + data[i]!) / period; result.push(s); }
    return result;
  }

  last(candles: Candle[], period = 14): number | null {
    if (candles.length < period * 2 + 1) return null;
    const trs: number[] = [], pdms: number[] = [], ndms: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const cur = candles[i]!, prev = candles[i - 1]!;
      trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
      const up = cur.high - prev.high, down = prev.low - cur.low;
      pdms.push(up > down && up > 0 ? up : 0);
      ndms.push(down > up && down > 0 ? down : 0);
    }
    const atr = this.wilderSum(trs, period), pdmS = this.wilderSum(pdms, period), ndmS = this.wilderSum(ndms, period);
    const dx: number[] = [];
    for (let i = 0; i < atr.length; i++) {
      if (!atr[i]) continue;
      const p = 100 * pdmS[i]! / atr[i]!, n = 100 * ndmS[i]! / atr[i]!, sum = p + n;
      if (sum) dx.push(100 * Math.abs(p - n) / sum);
    }
    const adx = this.wilderAvg(dx, period);
    const val = adx[adx.length - 1];
    return val !== undefined ? Math.round(val * 100) / 100 : null;
  }
}
