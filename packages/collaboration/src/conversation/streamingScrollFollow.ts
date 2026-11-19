export const STREAM_FOLLOW_STIFFNESS = 130;
export const STREAM_FOLLOW_DAMPING = 24;
export const STREAM_FOLLOW_MASS = 1;
export const STREAM_FOLLOW_SETTLE_PX = 0.25;

const rootDiscriminant = Math.sqrt(
  STREAM_FOLLOW_DAMPING ** 2 - 4 * STREAM_FOLLOW_MASS * STREAM_FOLLOW_STIFFNESS,
);
const slowRoot =
  (-STREAM_FOLLOW_DAMPING + rootDiscriminant) / (2 * STREAM_FOLLOW_MASS);
const fastRoot =
  (-STREAM_FOLLOW_DAMPING - rootDiscriminant) / (2 * STREAM_FOLLOW_MASS);

export interface StreamingScrollStep {
  advancePx: number;
  velocityPxPerSecond: number;
}

export function computeStreamingScrollStep(
  lagPx: number,
  velocityPxPerSecond: number,
  elapsedMs: number,
): StreamingScrollStep {
  if (lagPx <= STREAM_FOLLOW_SETTLE_PX || elapsedMs <= 0) {
    return { advancePx: Math.max(0, lagPx), velocityPxPerSecond: 0 };
  }

  // Solve the overdamped spring for the full elapsed time. Clamping frame time
  // slows convergence when a busy renderer delivers fewer animation frames.
  const velocity = Math.max(0, velocityPxPerSecond);
  const slowCoefficient =
    (-velocity - fastRoot * lagPx) / (slowRoot - fastRoot);
  const fastCoefficient = lagPx - slowCoefficient;
  const slowTerm = slowCoefficient * Math.exp((slowRoot * elapsedMs) / 1000);
  const fastTerm = fastCoefficient * Math.exp((fastRoot * elapsedMs) / 1000);
  const remaining = slowTerm + fastTerm;
  if (remaining <= STREAM_FOLLOW_SETTLE_PX) {
    return { advancePx: lagPx, velocityPxPerSecond: 0 };
  }

  return {
    advancePx: Math.max(0, Math.min(lagPx, lagPx - remaining)),
    velocityPxPerSecond: Math.max(
      0,
      -slowRoot * slowTerm - fastRoot * fastTerm,
    ),
  };
}
