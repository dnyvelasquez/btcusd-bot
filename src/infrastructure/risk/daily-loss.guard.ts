import { logger } from '@infra/logger/logger';

export class DailyLossGuard {
  private currentDate = '';
  private losses = 0;

  private todayET(): string {
    return new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
  }

  private maybeReset(): void {
    const today = this.todayET();
    if (today !== this.currentDate) {
      if (this.currentDate) logger.info({ date: today }, 'Daily loss count reset');
      this.currentDate = today;
      this.losses = 0;
    }
  }

  recordResult(profit: number): void { this.maybeReset(); if (profit < 0) this.losses++; }
  isBlocked(maxDailyLosses: number): boolean { this.maybeReset(); return maxDailyLosses > 0 && this.losses >= maxDailyLosses; }
  lossCount(): number { this.maybeReset(); return this.losses; }
}
