import { BybitService } from '@bybit/bybit.service';
import type { Candle } from '@bybit/bybit.types';
import { CandleCache } from './candle-cache';
import { marketEvents } from './market-events';

export class MarketDataService {
  private bybit = new BybitService();
  private cache = new CandleCache();

  async loadCandles(symbol: string, timeframe: string, count = 200): Promise<void> {
    const response = await this.bybit.getCandles(symbol, timeframe, count);
    if (!response.success || !response.data) return;

    const key = `${symbol}_${timeframe}`;
    const previous = this.cache.get(key);
    this.cache.set(key, response.data);
    this.detectNewCandle(key, previous, response.data);
  }

  private detectNewCandle(key: string, oldCandles: Candle[], newCandles: Candle[]): void {
    if (oldCandles.length === 0 || newCandles.length === 0) return;
    const oldLast = oldCandles[oldCandles.length - 1];
    const newLast = newCandles[newCandles.length - 1];
    if (oldLast.time !== newLast.time) marketEvents.emit('new-candle', { key, candle: newLast });
  }

  getCandles(symbol: string, timeframe: string): Candle[] {
    const candles = this.cache.get(`${symbol}_${timeframe}`);
    return candles.length > 1 ? candles.slice(0, -1) : candles;
  }

  async syncSymbol(symbol: string): Promise<void> {
    for (const tf of ['M5', 'M15', 'H1']) {
      await this.loadCandles(symbol, tf, 200);
    }
    await this.loadCandles(symbol, 'H4', 200);
    await this.loadCandles(symbol, 'D1', 365);
  }
}
