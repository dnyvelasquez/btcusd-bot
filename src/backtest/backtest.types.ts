export type TradeResult = 'WIN' | 'LOSS' | 'BE' | 'OPEN';
export type SignalType = 'EMA_PB';

export interface BacktestTrade {
  tradeNumber: number;
  signalType: SignalType;
  direction: 'BULLISH' | 'BEARISH';
  side: 'BUY' | 'SELL';
  openTime: number;
  closeTime: number | null;
  openTimeISO: string;
  closeTimeISO: string | null;
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  plannedRr: number;
  actualRr: number | null;
  result: TradeResult;
  pnl: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  openTrades: number;
  winRate: number;
  profitFactor: number;
  avgRr: number;
  avgWinRr: number;
  avgLossRr: number;
  totalPnl: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
}

export interface BacktestReport {
  symbol: string;
  from: string;
  to: string;
  initialBalance: number;
  finalBalance: number;
  riskPercent: number;
  leverage: number;
  cooldownMinutes: number;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  generatedAt: string;
}

export interface BlockedWindow { from: string; to: string; label: string; }

export interface BacktestParams {
  symbol: string;
  from: string;
  to: string;
  initialBalance: number;
  riskPercent: number;
  leverage: number;
  maxQty: number;
  cooldownMinutes: number;
  blockedHours: BlockedWindow[];
  zoneProximityPoints: number;
  zoneSlBufferPoints: number;
  minSlPoints: number;
  minFvgPoints: number;
  emaSpreadMin: number;
  epH4Align: boolean;
  epM15Align: boolean;
  epSkipMonday: boolean;
  epMinHour: number;
  epMaxHour: number;
  epAdxMin: number;
  epAdxMax: number;
  epAdxPeriod: number;
  ciMax: number;
  maxConsecLosses: number;
  maxDailyLosses: number;
  maxConsecLossDays: number;
  trailRr: number;
  beAtPoints: number;
  beBuffer: number;
  partialTpEnabled: boolean;
  tpRr: number;
}
