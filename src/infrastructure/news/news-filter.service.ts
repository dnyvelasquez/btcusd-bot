import axios from 'axios';
import { logger } from '@infra/logger/logger';

interface FFEvent { title: string; country: string; date: string; impact: string; }

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const BLOCK_WINDOW_MS = 60_000;

export class NewsFilterService {
  private events: FFEvent[] = [];
  private lastFetchDate = '';
  private refreshTimer: NodeJS.Timeout | null = null;

  async initialize(): Promise<void> {
    await this.refresh();
    this.scheduleDailyRefresh();
  }

  isBlocked(): boolean {
    const now = Date.now();
    return this.events.some(e => Math.abs(now - new Date(e.date).getTime()) <= BLOCK_WINDOW_MS);
  }

  nextBlockedEvent(): { title: string; date: Date } | null {
    const now = Date.now();
    return this.events
      .map(e => ({ title: e.title, date: new Date(e.date) }))
      .filter(e => e.date.getTime() > now)
      .sort((a, b) => a.date.getTime() - b.date.getTime())[0] ?? null;
  }

  stop(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
  }

  private async refresh(attempt = 1): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastFetchDate === today && this.events.length > 0) return;
    try {
      const { data } = await axios.get<FFEvent[]>(CALENDAR_URL, {
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      this.events = data.filter(e => e.country === 'USD' && e.impact === 'High');
      this.lastFetchDate = today;
      logger.info({ count: this.events.length }, 'News calendar refreshed');
    } catch (err) {
      const delays = [5 * 60_000, 30 * 60_000];
      const delay = delays[attempt - 1];
      if (delay) setTimeout(() => this.refresh(attempt + 1), delay);
      else logger.warn(err, 'News calendar fetch failed — filter disabled');
    }
  }

  private scheduleDailyRefresh(): void {
    const now = new Date();
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    this.refreshTimer = setTimeout(async () => {
      this.lastFetchDate = '';
      await this.refresh();
      this.scheduleDailyRefresh();
    }, nextMidnight - Date.now());
  }
}
