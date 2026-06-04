import { RestClientV5, type KlineIntervalV3 } from 'bybit-api';

import { env } from '@config/env';
import type {
  AccountInfo,
  BybitResponse,
  Candle,
  OrderResult,
  Position,
  TickData,
} from './bybit.types';

const TIMEFRAME_MAP: Record<string, string> = {
  M1: '1',
  M5: '5',
  M15: '15',
  H1: '60',
  H4: '240',
  D1: 'D',
};

const MIN_QTY  = 0.001;
const QTY_STEP = 0.001;

function roundQty(qty: number): number {
  const steps = Math.round(qty / QTY_STEP);
  return Math.max(MIN_QTY, steps * QTY_STEP);
}

// Convert Bybit orderId string to a stable numeric ticket
function toTicket(orderId: string): number {
  return parseInt(orderId.slice(-12), 10);
}

export class BybitService {
  private readonly client: RestClientV5;

  constructor() {
    this.client = new RestClientV5({
      key: env.BYBIT_API_KEY,
      secret: env.BYBIT_API_SECRET,
      testnet: env.BYBIT_TESTNET,
    });
  }

  async getAccount(): Promise<BybitResponse<AccountInfo>> {
    try {
      const res = await this.client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
      if (res.retCode !== 0) return { success: false, data: null as any, message: res.retMsg };

      const account = res.result.list[0];
      const usdt = account?.coin?.find(c => c.coin === 'USDT');
      if (!usdt) return { success: false, data: null as any, message: 'USDT wallet not found' };

      return {
        success: true,
        data: {
          login: 0,
          tradeMode: env.BYBIT_TESTNET ? 'DEMO' : 'REAL',
          balance: parseFloat(usdt.walletBalance),
          equity: parseFloat(usdt.equity),
          margin: parseFloat(usdt.totalOrderIM ?? '0'),
          freeMargin: parseFloat(usdt.availableToWithdraw ?? usdt.walletBalance),
        },
      };
    } catch (err) {
      return { success: false, data: null as any, message: String(err) };
    }
  }

  async getCandles(symbol: string, timeframe: string, count = 200): Promise<BybitResponse<Candle[]>> {
    try {
      const interval = (TIMEFRAME_MAP[timeframe] ?? '5') as KlineIntervalV3;
      const res = await this.client.getKline({ category: 'linear', symbol, interval, limit: count });
      if (res.retCode !== 0) return { success: false, data: [], message: res.retMsg };

      // Bybit returns newest first — reverse to oldest-first
      const candles: Candle[] = [...res.result.list].reverse().map(([time, open, high, low, close, volume]) => ({
        time: Math.floor(parseInt(time) / 1000),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        tick_volume: parseFloat(volume),
      }));

      return { success: true, data: candles };
    } catch (err) {
      return { success: false, data: [], message: String(err) };
    }
  }

  async getTick(symbol: string): Promise<BybitResponse<TickData>> {
    try {
      const res = await this.client.getTickers({ category: 'linear', symbol });
      if (res.retCode !== 0) return { success: false, data: null as any, message: res.retMsg };

      const ticker = res.result.list[0];
      if (!ticker) return { success: false, data: null as any, message: 'No ticker data' };

      const price = parseFloat(ticker.lastPrice);
      const spread = parseFloat(ticker.bid1Price ?? ticker.lastPrice) * 0.0001; // approximate
      return {
        success: true,
        data: {
          bid: parseFloat(ticker.bid1Price ?? String(price)),
          ask: parseFloat(ticker.ask1Price ?? String(price)),
          last: price,
          time: Date.now(),
        },
      };
    } catch (err) {
      return { success: false, data: null as any, message: String(err) };
    }
  }

  async getPositions(symbol: string): Promise<BybitResponse<Position[]>> {
    try {
      const res = await this.client.getPositionInfo({ category: 'linear', symbol });
      if (res.retCode !== 0) return { success: false, data: [], message: res.retMsg };

      const positions: Position[] = res.result.list
        .filter(p => parseFloat(p.size) > 0)
        .map(p => ({
          ticket: toTicket(p.createdTime),
          symbol: p.symbol,
          type: p.side === 'Buy' ? 'BUY' : 'SELL',
          volume: parseFloat(p.size),
          priceOpen: parseFloat(p.avgPrice),
          stopLoss: parseFloat(p.stopLoss || '0'),
          takeProfit: parseFloat(p.takeProfit || '0'),
          profit: parseFloat(p.unrealisedPnl),
        }));

      return { success: true, data: positions };
    } catch (err) {
      return { success: false, data: [], message: String(err) };
    }
  }

  async getPositionHistory(ticket: number): Promise<BybitResponse<{ ticket: number; closePrice: number; profit: number }>> {
    try {
      const res = await this.client.getClosedPnL({ category: 'linear', limit: 1 });
      if (res.retCode !== 0) return { success: false, data: null as any, message: res.retMsg };

      const entry = res.result.list[0];
      if (!entry) return { success: false, data: null as any, message: 'No closed PnL found' };

      return {
        success: true,
        data: {
          ticket,
          closePrice: parseFloat(entry.avgExitPrice),
          profit: parseFloat(entry.closedPnl),
        },
      };
    } catch (err) {
      return { success: false, data: null as any, message: String(err) };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.client.setLeverage({
        category: 'linear',
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
    } catch {
      // Already set or not required — non-fatal
    }
  }

  async placeOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    stopLoss: number;
    takeProfit: number;
  }): Promise<OrderResult> {
    try {
      const qty = roundQty(params.qty);
      const res = await this.client.submitOrder({
        category: 'linear',
        symbol: params.symbol,
        side: params.side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: qty.toFixed(3),
        stopLoss: params.stopLoss.toFixed(2),
        takeProfit: params.takeProfit.toFixed(2),
        timeInForce: 'GTC',
        positionIdx: 0,
      });

      if (res.retCode !== 0) return { success: false, message: res.retMsg };

      return {
        success: true,
        orderId: toTicket(res.result.orderId),
      };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  }

  async modifyPosition(symbol: string, stopLoss: number, takeProfit: number): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await this.client.setTradingStop({
        category: 'linear',
        symbol,
        stopLoss: stopLoss.toFixed(2),
        takeProfit: takeProfit > 0 ? takeProfit.toFixed(2) : undefined,
        positionIdx: 0,
      });

      if (res.retCode !== 0) return { success: false, message: res.retMsg };
      return { success: true };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  }

  async partialClose(symbol: string, qty: number, side: 'BUY' | 'SELL'): Promise<{ success: boolean; message?: string }> {
    try {
      const closeSide = side === 'BUY' ? 'Sell' : 'Buy';
      const res = await this.client.submitOrder({
        category: 'linear',
        symbol,
        side: closeSide,
        orderType: 'Market',
        qty: roundQty(qty).toFixed(3),
        reduceOnly: true,
        positionIdx: 0,
      });

      if (res.retCode !== 0) return { success: false, message: res.retMsg };
      return { success: true };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  }

  async closePosition(symbol: string, side: 'BUY' | 'SELL', qty: number): Promise<{ success: boolean; message?: string }> {
    try {
      const closeSide = side === 'BUY' ? 'Sell' : 'Buy';
      const res = await this.client.submitOrder({
        category: 'linear',
        symbol,
        side: closeSide,
        orderType: 'Market',
        qty: roundQty(qty).toFixed(3),
        reduceOnly: true,
        positionIdx: 0,
      });

      if (res.retCode !== 0) return { success: false, message: res.retMsg };
      return { success: true };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  }
}
