/** Capture exit state without changing animation playback or Issue state. */
export function collectIssueDrawerDiagnostics() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="issue-conversation-drawers"]')
  ).map(track => ({
    dismissing: track.dataset.dismissing,
    hasConversation: track.dataset.hasConversation,
    inert: track.inert,
    transform: getComputedStyle(track).transform,
    bounds: track.getBoundingClientRect().toJSON(),
    animations: track.getAnimations().map(animation => ({
      playState: animation.playState,
      pending: animation.pending,
      currentTime: animation.currentTime,
      startTime: animation.startTime,
      timing: animation.effect?.getComputedTiming(),
    })),
  }))
}
