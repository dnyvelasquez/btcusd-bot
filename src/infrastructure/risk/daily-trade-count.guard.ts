import { logger } from '@infra/logger/logger';

export class DailyTradeCountGuard {
  private currentDate = '';
  private count = 0;

  private todayUTC(): string { return new Date().toISOString().slice(0, 10); }

  private maybeReset(): void {
    const today = this.todayUTC();
    if (today !== this.currentDate) {
      if (this.currentDate) logger.info({ date: today }, 'Daily trade count reset');
      this.currentDate = today;
      this.count = 0;
    }
  }

  increment(): void { this.maybeReset(); this.count++; }
  isBreached(maxTrades: number): boolean { this.maybeReset(); return maxTrades > 0 && this.count >= maxTrades; }
  tradeCount(): number { this.maybeReset(); return this.count; }
}
