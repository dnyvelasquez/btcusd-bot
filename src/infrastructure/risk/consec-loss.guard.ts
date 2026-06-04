import { logger } from '@infra/logger/logger';

export class ConsecLossGuard {
  private streak = 0;
  private blockedDay = '';

  resetDay(): void { this.streak = 0; this.blockedDay = ''; }

  recordResult(profit: number): void {
    if (profit < 0) { this.streak++; }
    else { this.streak = 0; }
  }

  isBlocked(maxConsecLosses: number, todayET: string): boolean {
    if (maxConsecLosses <= 0) return false;
    if (this.streak >= maxConsecLosses) {
      if (this.blockedDay !== todayET) {
        this.blockedDay = todayET;
        logger.warn({ streak: this.streak, limit: maxConsecLosses }, 'ConsecLossGuard: circuit breaker triggered');
      }
      return true;
    }
    return false;
  }

  get currentStreak(): number { return this.streak; }
}
