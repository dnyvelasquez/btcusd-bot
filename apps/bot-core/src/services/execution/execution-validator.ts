import type { ExecutionOrder } from './execution-types';

const MIN_QTY = 0.001;

export class ExecutionValidator {
  validate(order: ExecutionOrder): boolean {
    if (!order.symbol) return false;
    if (order.qty < MIN_QTY) return false;
    if (order.stopLoss <= 0 || order.takeProfit <= 0) return false;
    if (order.side === 'BUY' && order.stopLoss >= order.entryPrice) return false;
    if (order.side === 'SELL' && order.stopLoss <= order.entryPrice) return false;
    return true;
  }
}
