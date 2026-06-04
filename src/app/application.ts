import { logger } from '@infra/logger/logger';
import { TelegramService } from '@infra/telegram/telegram.service';
import { LicenseService } from '@infra/license/license.service';
import { NewsFilterService } from '@infra/news/news-filter.service';
import { DailyTradeCountGuard } from '@infra/risk/daily-trade-count.guard';
import { ConsecLossGuard } from '@infra/risk/consec-loss.guard';
import { DailyLossGuard } from '@infra/risk/daily-loss.guard';
import { SessionGuard } from '@infra/session/session-guard';
import { TradeJournalService } from '@infra/journal/trade-journal.service';
import { BotStatusService } from '@infra/status/bot-status.service';

import { configService } from '@config/config-service';

import { MarketDataService } from '@bot-core/market-data/market-data.service';
import { FVGDetector } from '@bot-core/strategy/fvg/fvg-detector';
import { DisplacementDetector } from '@bot-core/strategy/fvg/displacement-detector';
import { EntryValidator } from '@bot-core/strategy/entry/entry-validator';
import { PositionSizing } from '@bot-core/strategy/risk/position-sizing';
import { EMAEngine } from '@bot-core/strategy/indicators/ema-engine';
import { MACDEngine } from '@bot-core/strategy/indicators/macd-engine';
import { ADXEngine } from '@bot-core/strategy/indicators/adx-engine';
import { ExecutionValidator } from '@bot-core/services/execution/execution-validator';
import { BybitExecutor } from '@bot-core/services/execution/bybit-executor';
import { PositionMonitor } from '@bot-core/services/execution/position-monitor';

import { BybitService } from '../services/bybit/bybit.service';
import type { MomentumSignal } from '@bot-core/strategy/momentum/momentum-types';

const POLL_INTERVAL_MS = 10_000;
const MIN_QTY = 0.001;

interface EPSignal {
  direction: 'BULLISH' | 'BEARISH';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  momentum: MomentumSignal;
}

export class Application {
  private readonly telegram = new TelegramService();
  private readonly marketData = new MarketDataService();
  private readonly bybit = new BybitService();

  private readonly fvgDetector = new FVGDetector();
  private readonly displacementDetector = new DisplacementDetector();
  private readonly entryValidator = new EntryValidator();
  private readonly emaEngine = new EMAEngine();
  private readonly macdEngine = new MACDEngine();
  private readonly adxEngine = new ADXEngine();
  private readonly positionSizing = new PositionSizing();
  private readonly executionValidator = new ExecutionValidator();
  private readonly executor = new BybitExecutor();
  private readonly positionMonitor = new PositionMonitor(
    configService.beAtPoints,
    configService.beBufferPoints,
    configService.trailRr,
  );

  private readonly licenseService = new LicenseService();
  private readonly newsFilter = new NewsFilterService();
  private readonly dailyTradeCountGuard = new DailyTradeCountGuard();
  private readonly consecLossGuard = new ConsecLossGuard();
  private readonly dailyLossGuard = new DailyLossGuard();
  private readonly sessionGuard = new SessionGuard();
  private readonly journal = new TradeJournalService('BTC Bot');
  private readonly statusService = new BotStatusService();

  private pollTimer: NodeJS.Timeout | null = null;
  private readonly lastSignalTime = new Map<'BULLISH' | 'BEARISH', number>();
  private openPositionTickets = new Set<number>();
  private lastKnownBalance = 0;
  private apiDown = false;
  private sessionOpen = false;
  private approvalPending = false;
  private eodCloseDone = false;
  private dayOpenBalance = 0;
  private consecBadDays = 0;
  private pauseUntilMon = false;

  public async start(): Promise<void> {
    logger.info('BTC Bot starting...');

    await this.validateLicense();
    await this.bybit.setLeverage(configService.symbol, configService.leverage);
    await this.journal.initialize();
    await this.newsFilter.initialize();
    await this.telegram.initialize();
    await this.sync();

    this.pollTimer = setInterval(() => {
      this.sync().catch((err: unknown) => logger.error(err, 'Unexpected sync error'));
    }, POLL_INTERVAL_MS);

    logger.info(`BTC Bot started — ${configService.symbol} | risk: ${configService.riskPercent}% | leverage: ${configService.leverage}x | live: ${configService.liveTrading}`);
    await this.telegram.notifyStartup(configService.symbol, configService.riskPercent, configService.liveTrading);
  }

  private async validateLicense(): Promise<void> {
    const tradeMode = (await this.bybit.getAccount()).data?.tradeMode ?? 'DEMO';
    await this.licenseService.validate(tradeMode);
  }

  private async sync(): Promise<void> {
    const symbol = configService.symbol;
    try {
      await this.marketData.syncSymbol(symbol);

      const m5Len = this.marketData.getCandles(symbol, 'M5').length;
      const isOpen = m5Len > 0;

      if (isOpen) {
        logger.info({ symbol, m5: m5Len }, 'Sync OK');
        await this.monitorOpenPositions();

        const session = this.sessionGuard.isBlocked(configService.blockedHours);
        if (session.blocked) {
          if (!this.eodCloseDone && this.openPositionTickets.size > 0) {
            await this.closeAllPositions(symbol);
          }
        } else if (this.pauseUntilMon) {
          logger.debug('Paused until Monday');
        } else {
          const signal = this.evaluateEMAPullback(symbol);
          if (signal) await this.onSignal(signal).catch((err: unknown) => logger.error(err, 'Signal error'));
        }
      }

      if (isOpen && !this.sessionOpen) {
        this.sessionOpen = true;
        this.eodCloseDone = false;
        const acct = await this.bybit.getAccount();
        if (acct.success && acct.data) {
          this.lastKnownBalance = acct.data.balance;
          this.dayOpenBalance = acct.data.balance;
          this.consecLossGuard.resetDay();
        }
        const isMonday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()) === 'Mon';
        if (isMonday) { this.consecBadDays = 0; this.pauseUntilMon = false; }
        await this.telegram.notifyMarketOpen();
      } else if (!isOpen && this.sessionOpen) {
        this.sessionOpen = false;
        if (configService.maxConsecLossDays > 0 && this.dayOpenBalance > 0) {
          if (this.lastKnownBalance < this.dayOpenBalance) {
            this.consecBadDays++;
            if (this.consecBadDays >= configService.maxConsecLossDays) this.pauseUntilMon = true;
          } else { this.consecBadDays = 0; }
        }
        await this.telegram.notifyMarketClosed();
      }

      if (this.apiDown) {
        this.apiDown = false;
        await this.telegram.notifyApiRecovered();
      }

      this.writeStatus();
    } catch (err) {
      logger.error(err, 'Sync failed — Bybit API unreachable');
      if (!this.apiDown) { this.apiDown = true; await this.telegram.notifyApiDown(String(err)); }
      this.writeStatus();
    }
  }

  private writeStatus(): void {
    const now = new Date().toISOString();
    const metrics = {
      dailyTrades: this.dailyTradeCountGuard.tradeCount(),
      maxDailyTrades: configService.maxDailyTrades,
      consecStreak: this.consecLossGuard.currentStreak,
      maxConsecLosses: configService.maxConsecLosses,
    };
    const write = (ready: boolean, reason: string | null) =>
      this.statusService.write({ ready, reason, updatedAt: now, metrics });

    if (this.apiDown) { write(false, 'Bybit API no disponible — reconectando...'); return; }
    if (!this.sessionOpen) { write(false, 'Sesión cerrada'); return; }
    const session = this.sessionGuard.isBlocked(configService.blockedHours);
    if (session.blocked) { write(false, `Horario bloqueado — ${session.label}`); return; }
    if (this.newsFilter.isBlocked()) {
      const next = this.newsFilter.nextBlockedEvent();
      write(false, `Noticias — ${next?.title ?? 'USD high-impact'}`); return;
    }
    if (this.dailyTradeCountGuard.isBreached(configService.maxDailyTrades)) {
      write(false, `Máx trades diarios (${metrics.dailyTrades}/${metrics.maxDailyTrades})`); return;
    }
    write(true, null);
  }

  private evaluateEMAPullback(symbol: string): EPSignal | null {
    const nowET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).format(new Date());
    const [weekday, hourStr] = nowET.split(', ');
    const hourNum = parseInt(hourStr ?? '0', 10);
    if (configService.epSkipMonday && weekday === 'Mon') return null;
    if (configService.epMinHour > 0 && hourNum < configService.epMinHour) return null;
    if (configService.epMaxHour > 0 && hourNum >= configService.epMaxHour) return null;

    const h4 = this.marketData.getCandles(symbol, 'H4');
    const h1 = this.marketData.getCandles(symbol, 'H1');
    const m15 = this.marketData.getCandles(symbol, 'M15');
    const m5 = this.marketData.getCandles(symbol, 'M5');

    if (h1.length < 40 || m15.length < 40 || m5.length < 1) return null;

    const h1Ema8 = this.emaEngine.last(h1, 8);
    const h1Ema34 = this.emaEngine.last(h1, 34);
    if (h1Ema8 === null || h1Ema34 === null) return null;

    const direction: 'BULLISH' | 'BEARISH' = h1Ema8 > h1Ema34 ? 'BULLISH' : 'BEARISH';

    if (configService.emaSpreadMin > 0 && Math.abs(h1Ema8 - h1Ema34) < configService.emaSpreadMin) return null;

    if (configService.epH4Align) {
      const h4Ema8 = this.emaEngine.last(h4, 8);
      const h4Ema34 = this.emaEngine.last(h4, 34);
      if (h4Ema8 === null || h4Ema34 === null) return null;
      if (direction === 'BULLISH' && h4Ema8 < h4Ema34) return null;
      if (direction === 'BEARISH' && h4Ema8 > h4Ema34) return null;
    }

    const m15Ema34 = this.emaEngine.last(m15, 34);
    if (m15Ema34 === null) return null;

    if (configService.epM15Align) {
      const m15Ema8 = this.emaEngine.last(m15, 8);
      if (m15Ema8 === null) return null;
      if (direction === 'BULLISH' && m15Ema8 < m15Ema34) return null;
      if (direction === 'BEARISH' && m15Ema8 > m15Ema34) return null;
    }

    const currentPrice = m5[m5.length - 1]!.close;
    if (Math.abs(currentPrice - m15Ema34) > configService.zoneProximityPoints) return null;

    if (configService.epAdxMin > 0) {
      const adx = this.adxEngine.last(h4, configService.epAdxPeriod);
      if (adx === null || adx < configService.epAdxMin) return null;
    }

    const macd = this.macdEngine.analyze(m15);
    if (!macd) return null;
    if (direction === 'BULLISH' && macd.histogram <= 0) return null;
    if (direction === 'BEARISH' && macd.histogram >= 0) return null;

    const entryPrice = currentPrice;
    const stopLoss = direction === 'BULLISH'
      ? m15Ema34 - configService.zoneSlBufferPoints
      : m15Ema34 + configService.zoneSlBufferPoints;

    const slDist = Math.abs(entryPrice - stopLoss);
    if (configService.minSlPoints > 0 && slDist < configService.minSlPoints) return null;

    const takeProfit = direction === 'BULLISH'
      ? entryPrice + slDist * 2
      : entryPrice - slDist * 2;

    return {
      direction, entryPrice, stopLoss, takeProfit,
      momentum: { direction, strength: 'NONE', timestamp: m5[m5.length - 1]!.time },
    };
  }

  private async monitorOpenPositions(): Promise<void> {
    const response = await this.bybit.getPositions(configService.symbol);
    if (!response.success) return;

    const currentPositions = response.data ?? [];
    const currentTickets = new Set(currentPositions.map(p => p.ticket));

    for (const ticket of this.openPositionTickets) {
      if (!currentTickets.has(ticket)) await this.onPositionClosed(ticket);
    }
    this.openPositionTickets = currentTickets;

    for (const position of currentPositions) {
      const tickRes = await this.bybit.getTick(position.symbol);
      if (!tickRes.success) continue;

      const currentPrice = position.type === 'BUY' ? tickRes.data.bid : tickRes.data.ask;
      const action = this.positionMonitor.check(position, currentPrice, configService.partialTpEnabled);
      if (!action) continue;

      if (action.reason === 'PARTIAL_TP' && action.partialQty) {
        await this.bybit.partialClose(position.symbol, action.partialQty, position.type);
        await this.bybit.modifyPosition(position.symbol, action.newSL, action.keepTP);
        await this.telegram.notifyPartialTP({ ticket: action.ticket, symbol: action.symbol, volume: action.partialQty, price: currentPrice });
        continue;
      }

      const result = await this.bybit.modifyPosition(position.symbol, action.newSL, action.keepTP);
      if (!result.success) { logger.error({ ticket: action.ticket, reason: action.reason }, 'Modify failed'); continue; }

      if (action.reason === 'BREAK_EVEN') {
        await this.telegram.notifyBreakEven({ ticket: action.ticket, symbol: action.symbol, price: action.newSL });
      } else {
        await this.telegram.notifyTrailingStop({ ticket: action.ticket, symbol: action.symbol, newSL: action.newSL });
      }
    }
  }

  private async onPositionClosed(ticket: number): Promise<void> {
    this.positionMonitor.clearTicket(ticket);
    try {
      const history = await this.bybit.getPositionHistory(ticket);
      if (history.success && history.data) {
        const { closePrice, profit } = history.data;
        await this.journal.recordClose(ticket, closePrice, profit);
        this.consecLossGuard.recordResult(profit);
        this.dailyLossGuard.recordResult(profit);
        if (profit > 0 || profit < 0) {
          const acct = await this.bybit.getAccount();
          if (acct.success && acct.data) this.lastKnownBalance = acct.data.balance;
        }
      }
    } catch (err) {
      logger.warn({ ticket, err }, 'Could not fetch position history');
    }
  }

  private async closeAllPositions(symbol: string): Promise<void> {
    this.eodCloseDone = true;
    const res = await this.bybit.getPositions(symbol);
    if (!res.success || !res.data?.length) return;
    for (const pos of res.data) {
      await this.bybit.closePosition(symbol, pos.type, pos.volume);
    }
  }

  private async onSignal(signal: EPSignal): Promise<void> {
    const { direction, entryPrice, stopLoss, takeProfit } = signal;
    const symbol = configService.symbol;

    if (this.newsFilter.isBlocked()) return;

    const sessionCheck = this.sessionGuard.isBlocked(configService.blockedHours);
    if (sessionCheck.blocked) return;

    const posRes = await this.bybit.getPositions(symbol);
    if (!posRes.success || (posRes.data?.length ?? 0) > 0) return;

    const cooldownMs = configService.signalCooldownMinutes * 60_000;
    if ((Date.now() - (this.lastSignalTime.get(direction) ?? 0)) < cooldownMs) return;

    if (this.dailyTradeCountGuard.isBreached(configService.maxDailyTrades)) return;

    const todayET = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
    if (this.consecLossGuard.isBlocked(configService.maxConsecLosses, todayET)) return;
    if (this.dailyLossGuard.isBlocked(configService.maxDailyLosses)) return;

    const acctRes = await this.bybit.getAccount();
    if (!acctRes.success || !acctRes.data) return;

    const { balance } = acctRes.data;
    this.lastKnownBalance = balance;

    const sizing = this.positionSizing.calculate({
      accountBalance: balance,
      riskPercent: configService.riskPercent,
      entryPrice,
      stopLoss,
      target: takeProfit,
    });

    if (sizing.riskRewardRatio < 2) return;

    const qty = Math.min(configService.maxQty, Math.max(MIN_QTY, Math.round(sizing.qty * 1000) / 1000));

    const order = {
      symbol, side: direction === 'BULLISH' ? ('BUY' as const) : ('SELL' as const),
      qty, entryPrice, stopLoss, takeProfit,
    };

    const notifParams = {
      side: order.side, symbol, entry: entryPrice, sl: stopLoss, tp: takeProfit,
      volume: qty, rr: sizing.riskRewardRatio.toFixed(2), riskAmount: sizing.riskAmount.toFixed(2),
    };

    this.lastSignalTime.set(direction, Date.now());

    if (!configService.liveTrading) {
      logger.info({ ...order, rr: notifParams.rr }, '[PAPER] Trade setup');
      await this.telegram.notifyPaperSetup(notifParams);
      return;
    }

    if (configService.semiAutoMode) {
      if (this.approvalPending) return;
      this.approvalPending = true;
      let approved = false;
      try { approved = await this.telegram.sendTradeApproval(notifParams); }
      finally { this.approvalPending = false; }
      if (!approved) return;
    }

    if (!this.executionValidator.validate(order)) {
      logger.error({ order }, 'Order failed validation');
      return;
    }

    const result = await this.executor.execute(order);

    if (result.success) {
      logger.info({ orderId: result.orderId }, 'Order placed');
      await this.telegram.notifyOrderPlaced({ ...notifParams, orderId: result.orderId });
      this.dailyTradeCountGuard.increment();
      if (result.orderId !== undefined) {
        this.openPositionTickets.add(result.orderId);
        await this.journal.recordOpen({
          ticket: result.orderId,
          bybitAccount: acctRes.data.login.toString(),
          symbol, side: order.side, qty,
          entryPrice, stopLoss, takeProfit,
          plannedRr: sizing.riskRewardRatio,
          riskAmount: sizing.riskAmount,
        });
      }
    } else {
      logger.error({ message: result.message }, 'Order failed');
      await this.telegram.notifyOrderFailed({ side: order.side, symbol, reason: result.message });
    }
  }

  public async stop(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    configService.stop();
    this.newsFilter.stop();
    await this.telegram.stop();
    await this.journal.stop();
  }
}
