export const SIDEBAR_TITLE_DELAY_MS = 600
export const SIDEBAR_TITLE_RETURN_MS = 150
const SPEED_PX_PER_MS = 30 / 1000
const BRAKING_DISTANCE_PX = 40

export function getSidebarTitleMotion(distance: number) {
  const travel = Math.max(0, distance)
  const brakingDistance = Math.min(travel, BRAKING_DISTANCE_PX)
  const cruiseDistance = travel - brakingDistance
  const cruiseDuration = cruiseDistance / SPEED_PX_PER_MS
  const brakingDuration = (2 * brakingDistance) / SPEED_PX_PER_MS
  const duration = cruiseDuration + brakingDuration

  return {
    duration,
    positionAt(elapsedMs: number) {
      const elapsed = Math.max(0, elapsedMs)
      if (elapsed >= duration) return travel
      if (elapsed <= cruiseDuration) return elapsed * SPEED_PX_PER_MS
      const progress = (elapsed - cruiseDuration) / brakingDuration
      return cruiseDistance + brakingDistance * (2 * progress - progress * progress)
    },
  }
}
