import TelegramBot from 'node-telegram-bot-api';

import { env } from '@config/env';
import { configService } from '@config/config-service';
import { logger } from '@infra/logger/logger';

interface PendingApproval {
  messageId: number;
  chatId: string;
  baseText: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class TelegramService {
  private readonly bot: TelegramBot;
  private pendingApproval: PendingApproval | null = null;

  constructor() {
    this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: false });
  }

  public async initialize(): Promise<void> {
    const botInfo = await this.bot.getMe();
    logger.info(`Telegram connected: @${botInfo.username}`);
    if (!env.TELEGRAM_CHAT_ID) logger.warn('TELEGRAM_CHAT_ID not set — notifications disabled');
    this.bot.on('callback_query', (q) => this.handleCallbackQuery(q));
    if (configService.semiAutoMode) { await this.bot.startPolling(); logger.info('Telegram polling started'); }
  }

  private handleCallbackQuery(query: TelegramBot.CallbackQuery): void {
    if (!this.pendingApproval || query.message?.message_id !== this.pendingApproval.messageId) {
      this.bot.answerCallbackQuery(query.id, { text: 'Sin trade pendiente' }).catch(() => {});
      return;
    }
    const approved = query.data === 'execute';
    this.bot.answerCallbackQuery(query.id, { text: approved ? '✅ Ejecutando...' : '❌ Ignorado' }).catch(() => {});
    this.bot.editMessageText(
      this.pendingApproval.baseText + (approved ? '\n\n✅ <b>Aprobado</b>' : '\n\n❌ <b>Ignorado</b>'),
      { chat_id: this.pendingApproval.chatId, message_id: this.pendingApproval.messageId, parse_mode: 'HTML' }
    ).catch(() => {});
    const { resolve, timer } = this.pendingApproval;
    clearTimeout(timer);
    this.pendingApproval = null;
    resolve(approved);
  }

  async sendTradeApproval(params: {
    side: string; symbol: string; entry: number; sl: number; tp: number; volume: number; rr: string; riskAmount: string;
  }, timeoutMs = 180_000): Promise<boolean> {
    if (!env.TELEGRAM_CHAT_ID) return false;
    const { side, symbol, entry, sl, tp, volume, rr, riskAmount } = params;
    const baseText =
      `📋 <b>Setup — ${side} ${symbol}</b>\n<i>Responde en 3 minutos…</i>\n\n` +
      `Entry:  <code>${entry.toFixed(2)}</code>\nSL:     <code>${sl.toFixed(2)}</code>\nTP:     <code>${tp.toFixed(2)}</code>\n\n` +
      `Qty: ${volume} BTC | R:R: ${rr} | Riesgo: $${riskAmount}`;
    const msg = await this.bot.sendMessage(env.TELEGRAM_CHAT_ID, baseText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '✅ Ejecutar', callback_data: 'execute' }, { text: '❌ Ignorar', callback_data: 'ignore' }]] },
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.bot.editMessageText(baseText + '\n\n⏱ <i>Sin respuesta — cancelado</i>',
          { chat_id: env.TELEGRAM_CHAT_ID!, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => {});
        this.pendingApproval = null;
        resolve(false);
      }, timeoutMs);
      this.pendingApproval = { messageId: msg.message_id, chatId: env.TELEGRAM_CHAT_ID!, baseText, resolve, timer };
    });
  }

  public async stop(): Promise<void> { await this.bot.stopPolling().catch(() => {}); }

  private async send(html: string): Promise<void> {
    if (!env.TELEGRAM_CHAT_ID || !configService.telegramEnabled) return;
    try { await this.bot.sendMessage(env.TELEGRAM_CHAT_ID, html, { parse_mode: 'HTML' }); }
    catch (err) { logger.warn(err, 'Telegram send failed'); }
  }

  async notifyStartup(symbol: string, riskPercent: number, liveTrading: boolean): Promise<void> {
    await this.send(`🤖 <b>BTC Bot iniciado</b>\nSímbolo: <code>${symbol}</code> | Riesgo: ${riskPercent}% | ${liveTrading ? 'LIVE 🔴' : 'PAPER 🟡'}`);
  }
  async notifyPaperSetup(p: { side: string; symbol: string; entry: number; sl: number; tp: number; volume: number; rr: string; riskAmount: string }): Promise<void> {
    await this.send(`📋 <b>[PAPER] ${p.side} ${p.symbol}</b>\nEntry: <code>${p.entry.toFixed(2)}</code> | SL: <code>${p.sl.toFixed(2)}</code> | TP: <code>${p.tp.toFixed(2)}</code>\nQty: ${p.volume} BTC | R:R: ${p.rr} | Riesgo: $${p.riskAmount}`);
  }
  async notifyOrderPlaced(p: { orderId?: number; side: string; symbol: string; entry: number; sl: number; tp: number; volume: number; rr: string; riskAmount: string }): Promise<void> {
    await this.send(`✅ <b>Orden ejecutada — ${p.side} ${p.symbol}</b>\nID: <code>${p.orderId ?? 'N/A'}</code>\nEntry: <code>${p.entry.toFixed(2)}</code> | SL: <code>${p.sl.toFixed(2)}</code> | TP: <code>${p.tp.toFixed(2)}</code>\nQty: ${p.volume} BTC | R:R: ${p.rr} | Riesgo: $${p.riskAmount}`);
  }
  async notifyOrderFailed(p: { side: string; symbol: string; reason?: string }): Promise<void> {
    await this.send(`❌ <b>Orden fallida — ${p.side} ${p.symbol}</b>\n<code>${p.reason}</code>`);
  }
  async notifyMarketOpen(): Promise<void> { await this.send(`🟢 <b>Sesión abierta</b> — BTCUSDT`); }
  async notifyMarketClosed(): Promise<void> { await this.send(`🔴 <b>Sesión cerrada</b> — BTCUSDT`); }
  async notifyBreakEven(p: { ticket: number; symbol: string; price: number }): Promise<void> {
    await this.send(`🔒 <b>Break-even</b> — ${p.symbol}\nSL movido a <code>${p.price.toFixed(2)}</code>`);
  }
  async notifyTrailingStop(p: { ticket: number; symbol: string; newSL: number }): Promise<void> {
    await this.send(`📈 <b>Trailing stop</b> — ${p.symbol}\nNuevo SL: <code>${p.newSL.toFixed(2)}</code>`);
  }
  async notifyPartialTP(p: { ticket: number; symbol: string; volume: number; price: number }): Promise<void> {
    await this.send(`📊 <b>Partial TP</b> — ${p.symbol}\nCerrado: ${p.volume} BTC @ <code>${p.price.toFixed(2)}</code>`);
  }
  async notifyApiDown(reason: string): Promise<void> {
    await this.send(`🔌 <b>Bybit API desconectada</b>\n<code>${reason}</code>`);
  }
  async notifyApiRecovered(): Promise<void> {
    await this.send(`✅ <b>Bybit API reconectada</b>`);
  }
}
