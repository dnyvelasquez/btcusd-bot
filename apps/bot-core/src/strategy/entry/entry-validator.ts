import type { MomentumDirection } from '../momentum/momentum-types';

interface ValidationContext {
  htfBias: 'BULLISH' | 'BEARISH';
  m15Momentum: MomentumDirection;
  hasDisplacement: boolean;
  hasFVG: boolean;
}

export class EntryValidator {
  validate(context: ValidationContext): boolean {
    return context.m15Momentum === context.htfBias && context.hasDisplacement && context.hasFVG;
  }
}
