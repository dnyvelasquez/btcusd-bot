// BTC USDT-margined perpetuals: qty = riskUSD / slDistanceUSD (no tick value needed)

export interface BtcPositionSizingResult {
  riskAmount: number;
  stopDistance: number;
  qty: number;
  riskRewardRatio: number;
}

export interface BtcRiskParameters {
  accountBalance: number;
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
}

const MIN_QTY  = 0.001;
const QTY_STEP = 0.001;

export class PositionSizing {
  calculate(params: BtcRiskParameters): BtcPositionSizingResult {
    const riskAmount = params.accountBalance * (params.riskPercent / 100);
    const stopDistance = Math.abs(params.entryPrice - params.stopLoss);
    const targetDistance = Math.abs(params.target - params.entryPrice);
    const riskRewardRatio = stopDistance > 0 ? targetDistance / stopDistance : 0;

    // qty (BTC) = riskUSD / slDistanceUSD
    const rawQty = stopDistance > 0 ? riskAmount / stopDistance : MIN_QTY;
    const steps = Math.max(1, Math.round(rawQty / QTY_STEP));
    const qty = steps * QTY_STEP;

    return { riskAmount, stopDistance, qty, riskRewardRatio };
  }
}
