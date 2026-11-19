import type { DebugLogEntry } from '@/lib/debugPanel'

const LOG_PREFIX = '[Wework] Issue drawer diagnostic'

function trackSnapshot(track: HTMLElement) {
  const rect = track.getBoundingClientRect()
  return {
    instanceId: Number(track.dataset.diagnosticInstance) || null,
    dismissing: track.dataset.dismissing === 'true',
    hasConversation: track.dataset.hasConversation === 'true',
    connected: track.isConnected,
    inert: track.inert,
    transform: getComputedStyle(track).transform,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    animations: track
      .getAnimations()
      .slice(0, 4)
      .map(animation => ({
        property:
          typeof CSSTransition !== 'undefined' &&
          animation instanceof CSSTransition &&
          ['transform', 'width'].includes(animation.transitionProperty)
            ? animation.transitionProperty
            : 'other',
        playState: animation.playState,
        currentTime:
          typeof animation.currentTime === 'number' && Number.isFinite(animation.currentTime)
            ? animation.currentTime
            : null,
        pending: animation.pending,
        startTime: animation.startTime,
        timing: animation.effect?.getComputedTiming(),
      })),
  }
}

export function collectIssueDrawerDiagnostics(logs: DebugLogEntry[] = []) {
  try {
    const route = new URL(location.href)
    return {
      capturedAtUnixMs: Date.now(),
      timeOrigin: performance.timeOrigin,
      route: {
        isTodo: route.pathname.endsWith('/todo'),
        hasProjectId: route.searchParams.has('projectId'),
        hasItemId: route.searchParams.has('itemId'),
        hasFocusRequest: route.searchParams.has('focusRequest'),
        hasCommentId: route.searchParams.has('commentId'),
      },
      tracks: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.issue-conversation-drawers, [data-testid="issue-conversation-drawers"]'
        )
      )
        .slice(0, 4)
        .map(trackSnapshot),
      // The existing journal retains completed instances after their DOM is gone.
      lifecycle: logs.filter(entry => entry.args[0] === LOG_PREFIX).slice(-48),
    }
  } catch {
    return { unavailable: true }
  }
}
