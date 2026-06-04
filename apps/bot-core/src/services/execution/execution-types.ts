export type OrderSide = 'BUY' | 'SELL';

export interface ExecutionOrder {
  symbol: string;
  side: OrderSide;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface ExecutionResult {
  success: boolean;
  orderId?: number;
  message: string;
}
