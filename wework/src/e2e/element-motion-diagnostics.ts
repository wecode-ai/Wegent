function booleanState(element: Element): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const name of element.getAttributeNames()) {
    if (!name.startsWith('data-')) continue
    const value = element.getAttribute(name)
    if (value === 'true' || value === 'false') flags[name] = value === 'true'
  }
  return flags
}

/** Inspect motion only after a wait fails, without copying text, keyframes, or input values. */
export function getElementMotionDiagnostics(element: HTMLElement) {
  const descendants = Array.from(element.querySelectorAll('*'))
  const states = [element, ...descendants.slice(0, 128)]
    .map(target => ({ tag: target.tagName, flags: booleanState(target) }))
    .filter(target => Object.keys(target.flags).length > 0)
  const state = {
    scannedElements: Math.min(descendants.length, 128) + 1,
    unscannedElements: Math.max(0, descendants.length - 128),
    states: states.slice(0, 16),
    omittedStates: Math.max(0, states.length - 16),
  }
  if (typeof element.getAnimations !== 'function') return { ...state, animations: null }
  try {
    const animations = element.getAnimations({ subtree: true })
    return {
      ...state,
      animationCount: animations.length,
      animations: animations.slice(0, 16).map(animation => ({
        playState: ['idle', 'running', 'paused', 'finished'].includes(animation.playState)
          ? animation.playState
          : 'unknown',
        pending: typeof animation.pending === 'boolean' ? animation.pending : null,
        currentTime:
          typeof animation.currentTime === 'number' && Number.isFinite(animation.currentTime)
            ? animation.currentTime
            : null,
      })),
      omittedAnimations: Math.max(0, animations.length - 16),
    }
  } catch {
    return { ...state, animations: null }
  }
}
