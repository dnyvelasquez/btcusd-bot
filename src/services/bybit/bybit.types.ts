export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
}

export interface AccountInfo {
  uid: number;
  tradeMode: 'DEMO' | 'REAL';
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
}

export interface Position {
  ticket: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  volume: number;
  priceOpen: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
}

export interface TickData {
  bid: number;
  ask: number;
  last: number;
  time: number;
}

export interface BybitResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: number;
  message?: string;
}
