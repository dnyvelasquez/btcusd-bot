export interface Displacement {
  direction: 'BULLISH' | 'BEARISH';
  candleTime: number;
  bodySize: number;
  range: number;
  strength: number;
}

export interface FairValueGap {
  direction: 'BULLISH' | 'BEARISH';
  startPrice: number;
  endPrice: number;
  candleTime: number;
  size: number;
}
