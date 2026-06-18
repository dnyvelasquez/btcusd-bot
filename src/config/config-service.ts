import fs from 'fs';
import path from 'path';

import { logger } from '@infra/logger/logger';
import type { BlockedWindow } from '@infra/session/session-guard';
import { env } from './env';

const DEFAULT_BLOCKED_HOURS: BlockedWindow[] = [
  { from: '00:00', to: '08:00', label: 'Off-hours (low volume)' },
  { from: '17:00', to: '00:00', label: 'Off-hours (low volume)' },
];

interface BotConfig {
  SYMBOL: string;
  RISK_PERCENT: number;
  LIVE_TRADING: boolean;
  SIGNAL_COOLDOWN_MINUTES: number;
  LEVERAGE?: number;
  MAX_QTY?: number;
  TELEGRAM_ENABLED?: boolean;
  LICENSE_KEY?: string;
  BLOCKED_HOURS?: BlockedWindow[];
  MAX_DAILY_TRADES?: number;
  MAX_CONSEC_LOSSES?: number;
  MAX_CONSEC_LOSS_DAYS?: number;
  MAX_DAILY_LOSSES?: number;
  MIN_FVG_POINTS?: number;
  MIN_SL_POINTS?: number;
  PARTIAL_TP_ENABLED?: boolean;
  SEMI_AUTO_MODE?: boolean;
  ZONE_PROXIMITY_POINTS?: number;
  ZONE_SL_BUFFER_POINTS?: number;
  BE_AT_POINTS?: number;
  BE_BUFFER_POINTS?: number;
  TRAIL_RR?: number;
  EMA_SPREAD_MIN?: number;
  EP_M15_ALIGN?: boolean;
  EP_SKIP_MONDAY?: boolean;
  EP_MIN_HOUR?: number;
  EP_MAX_HOUR?: number;
  EP_ADX_PERIOD?: number;
  EP_ADX_MIN?: number;
  EP_ADX_MAX?: number;
  EP_H4_ALIGN?: boolean;
  CI_MAX?: number;
}

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');

class ConfigService {
  private config: BotConfig;
  private watcher: fs.FSWatcher | null = null;

  constructor() {
    this.config = this.mergeWithDefaults(this.loadFile());
    this.startWatcher();
  }

  get symbol(): string { return this.config.SYMBOL; }
  get riskPercent(): number { return this.config.RISK_PERCENT; }
  get liveTrading(): boolean { return this.config.LIVE_TRADING; }
  get signalCooldownMinutes(): number { return this.config.SIGNAL_COOLDOWN_MINUTES; }
  get leverage(): number { return this.config.LEVERAGE ?? 5; }
  get maxQty(): number { return this.config.MAX_QTY ?? 1.0; }
  get telegramEnabled(): boolean { return this.config.TELEGRAM_ENABLED ?? true; }
  get blockedHours(): BlockedWindow[] { return this.config.BLOCKED_HOURS?.length ? this.config.BLOCKED_HOURS : DEFAULT_BLOCKED_HOURS; }
  get maxDailyTrades(): number { return this.config.MAX_DAILY_TRADES ?? 0; }
  get maxConsecLosses(): number { return this.config.MAX_CONSEC_LOSSES ?? 0; }
  get maxConsecLossDays(): number { return this.config.MAX_CONSEC_LOSS_DAYS ?? 0; }
  get maxDailyLosses(): number { return this.config.MAX_DAILY_LOSSES ?? 0; }
  get minFvgPoints(): number { return this.config.MIN_FVG_POINTS ?? 0; }
  get minSlPoints(): number { return this.config.MIN_SL_POINTS ?? 0; }
  get partialTpEnabled(): boolean { return this.config.PARTIAL_TP_ENABLED ?? false; }
  get semiAutoMode(): boolean { return this.config.SEMI_AUTO_MODE ?? false; }
  get zoneProximityPoints(): number { return this.config.ZONE_PROXIMITY_POINTS ?? 500; }
  get zoneSlBufferPoints(): number { return this.config.ZONE_SL_BUFFER_POINTS ?? 150; }
  get beAtPoints(): number { return this.config.BE_AT_POINTS ?? 0; }
  get beBufferPoints(): number { return this.config.BE_BUFFER_POINTS ?? 50; }
  get trailRr(): number { return this.config.TRAIL_RR ?? 1.5; }
  get emaSpreadMin(): number { return this.config.EMA_SPREAD_MIN ?? 0; }
  get epM15Align(): boolean { return this.config.EP_M15_ALIGN ?? false; }
  get epSkipMonday(): boolean { return this.config.EP_SKIP_MONDAY ?? false; }
  get epMinHour(): number { return this.config.EP_MIN_HOUR ?? 8; }
  get epMaxHour(): number { return this.config.EP_MAX_HOUR ?? 17; }
  get epAdxPeriod(): number { return this.config.EP_ADX_PERIOD ?? 14; }
  get epAdxMin(): number { return this.config.EP_ADX_MIN ?? 0; }
  get epAdxMax(): number { return this.config.EP_ADX_MAX ?? 0; }
  get epH4Align(): boolean { return this.config.EP_H4_ALIGN ?? true; }
  get ciMax(): number { return this.config.CI_MAX ?? 61.8; }

  get licenseKey(): string | undefined {
    const fromFile = this.config.LICENSE_KEY;
    return fromFile && fromFile.length > 0 ? fromFile : env.LICENSE_KEY;
  }

  private mergeWithDefaults(file: BotConfig | null): BotConfig {
    const defaults: BotConfig = { SYMBOL: 'BTCUSDT', RISK_PERCENT: 1, LIVE_TRADING: false, SIGNAL_COOLDOWN_MINUTES: 60 };
    if (!file) return defaults;
    return {
      ...file,
      SYMBOL: file.SYMBOL ?? defaults.SYMBOL,
      RISK_PERCENT: file.RISK_PERCENT ?? defaults.RISK_PERCENT,
      LIVE_TRADING: file.LIVE_TRADING ?? defaults.LIVE_TRADING,
      SIGNAL_COOLDOWN_MINUTES: file.SIGNAL_COOLDOWN_MINUTES ?? defaults.SIGNAL_COOLDOWN_MINUTES,
    };
  }

  private loadFile(): BotConfig | null {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as BotConfig;
    } catch {
      return null;
    }
  }

  private startWatcher(): void {
    if (!fs.existsSync(CONFIG_PATH)) return;
    let debounce: NodeJS.Timeout | null = null;
    this.watcher = fs.watch(CONFIG_PATH, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const loaded = this.loadFile();
        if (loaded) {
          this.config = this.mergeWithDefaults(loaded);
          logger.info({ symbol: this.config.SYMBOL, risk: this.config.RISK_PERCENT, live: this.config.LIVE_TRADING }, 'Config reloaded');
        }
      }, 200);
    });
  }

  public stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

export const configService = new ConfigService();
