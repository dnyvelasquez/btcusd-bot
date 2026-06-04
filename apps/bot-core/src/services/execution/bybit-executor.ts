import { BybitService } from '@bybit/bybit.service';
import type { ExecutionOrder, ExecutionResult } from './execution-types';

export class BybitExecutor {
  private readonly bybit = new BybitService();

  async execute(order: ExecutionOrder): Promise<ExecutionResult> {
    const result = await this.bybit.placeOrder({
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
    });

    if (result.success) {
      return { success: true, orderId: result.orderId, message: 'Order executed' };
    }

    return { success: false, message: result.message ?? 'Execution failed' };
  }
}
