const FALLBACK_FRAME_MS = 16

export interface SafeAnimationFrameHandle {
  animationFrameId: number
  fallbackTimerId: number | null
}

export function requestSafeAnimationFrame(
  callback: FrameRequestCallback,
  { fallbackOnSynchronous = true }: { fallbackOnSynchronous?: boolean } = {}
): SafeAnimationFrameHandle {
  let synchronous = true
  let calledSynchronously = false
  const animationFrameId = requestAnimationFrame(now => {
    if (synchronous) {
      calledSynchronously = true
      return
    }
    callback(now)
  })
  synchronous = false

  return {
    animationFrameId,
    fallbackTimerId:
      calledSynchronously && fallbackOnSynchronous
        ? window.setTimeout(() => callback(performance.now()), FALLBACK_FRAME_MS)
        : null,
  }
}

export function cancelSafeAnimationFrame(handle: SafeAnimationFrameHandle): void {
  cancelAnimationFrame(handle.animationFrameId)
  if (handle.fallbackTimerId !== null) clearTimeout(handle.fallbackTimerId)
}
