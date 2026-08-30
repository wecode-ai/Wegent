export const STREAM_FOLLOW_STIFFNESS = 130
export const STREAM_FOLLOW_DAMPING = 24
export const STREAM_FOLLOW_MASS = 1
export const STREAM_FOLLOW_SUBSTEPS = 4
export const STREAM_FOLLOW_MAX_FRAME_MS = 32
export const STREAM_FOLLOW_SETTLE_PX = 0.25

export interface StreamingScrollStep {
  advancePx: number
  velocityPxPerSecond: number
}

export function computeStreamingScrollStep(
  lagPx: number,
  velocityPxPerSecond: number,
  elapsedMs: number
): StreamingScrollStep {
  if (lagPx <= STREAM_FOLLOW_SETTLE_PX || elapsedMs <= 0) {
    return { advancePx: Math.max(0, lagPx), velocityPxPerSecond: 0 }
  }

  let remaining = lagPx
  let velocity = Math.max(0, velocityPxPerSecond)
  const stepSeconds =
    Math.min(STREAM_FOLLOW_MAX_FRAME_MS, elapsedMs) / 1000 / STREAM_FOLLOW_SUBSTEPS

  for (let index = 0; index < STREAM_FOLLOW_SUBSTEPS; index += 1) {
    const acceleration =
      (STREAM_FOLLOW_STIFFNESS * remaining - STREAM_FOLLOW_DAMPING * velocity) / STREAM_FOLLOW_MASS
    velocity = Math.max(0, velocity + acceleration * stepSeconds)
    const advance = velocity * stepSeconds
    if (advance >= remaining) {
      return { advancePx: lagPx, velocityPxPerSecond: 0 }
    }
    remaining -= advance
  }

  return {
    advancePx: lagPx - remaining,
    velocityPxPerSecond: velocity,
  }
}
