export type MomentumDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export interface MomentumSignal { direction: MomentumDirection; strength: 'BOS' | 'CHOCH' | 'NONE'; timestamp: number; }
