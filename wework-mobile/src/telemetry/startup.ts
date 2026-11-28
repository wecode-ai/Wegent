const moduleLoadedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function mobileStartupElapsedMs(): number {
  return Math.max(0, now() - moduleLoadedAt)
}
