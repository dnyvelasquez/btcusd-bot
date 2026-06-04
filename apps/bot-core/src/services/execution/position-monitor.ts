import type { Position } from '@bybit/bybit.types';

export interface PositionAction {
  ticket: number;
  symbol: string;
  newSL: number;
  keepTP: number;
  reason: 'BREAK_EVEN' | 'TRAILING_STOP' | 'PARTIAL_TP';
  partialQty?: number;
}

export class PositionMonitor {
  private readonly partialTpDone = new Set<number>();

  constructor(
    private readonly beAtPoints: number = 0,
    private readonly beBuffer: number = 0,
    private readonly trailRr: number = 0,
  ) {}

  check(position: Position, currentPrice: number, partialTpEnabled = false): PositionAction | null {
    const slDistance = Math.abs(position.priceOpen - position.stopLoss);
    if (slDistance === 0) return null;

    const profitPoints = position.type === 'BUY'
      ? currentPrice - position.priceOpen
      : position.priceOpen - currentPrice;

    // Trailing stop
    if (this.trailRr > 0 && profitPoints >= slDistance * this.trailRr) {
      const trailDist = slDistance * this.trailRr;
      const newSL = position.type === 'BUY' ? currentPrice - trailDist : currentPrice + trailDist;
      const improves = position.type === 'BUY' ? newSL > position.stopLoss : newSL < position.stopLoss;
      if (improves) return { ticket: position.ticket, symbol: position.symbol, newSL, keepTP: position.takeProfit, reason: 'TRAILING_STOP' };
    }

    // Break-even / Partial TP
    if (this.beAtPoints > 0 && profitPoints >= this.beAtPoints) {
      const beSL = position.type === 'BUY' ? position.priceOpen + this.beBuffer : position.priceOpen - this.beBuffer;

      if (partialTpEnabled && !this.partialTpDone.has(position.ticket)) {
        this.partialTpDone.add(position.ticket);
        const halfQty = Math.max(0.001, Math.round((position.volume / 2) * 1000) / 1000);
        return { ticket: position.ticket, symbol: position.symbol, newSL: beSL, keepTP: position.takeProfit, reason: 'PARTIAL_TP', partialQty: halfQty };
      }

      if (!partialTpEnabled) {
        const alreadyBE = position.type === 'BUY' ? position.stopLoss >= beSL : position.stopLoss <= beSL;
        if (!alreadyBE) return { ticket: position.ticket, symbol: position.symbol, newSL: beSL, keepTP: position.takeProfit, reason: 'BREAK_EVEN' };
      }
    }

    return null;
  }

  clearTicket(ticket: number): void { this.partialTpDone.delete(ticket); }
}
