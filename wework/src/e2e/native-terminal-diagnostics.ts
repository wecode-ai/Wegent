export interface NativeTerminalViewport {
  viewportY: number
  baseY: number
  length: number
  rows: number
}

export type NativeTerminalElement = HTMLElement & {
  __weworkViewportForE2E?: () => NativeTerminalViewport
}

const samples: object[] = []

function terminalViewport(element: Element | null) {
  const panel = element?.closest('[data-testid="background-terminal-output-panel"]')
  const region = panel?.querySelector<NativeTerminalElement>('[role="region"]')
  const firstRow = panel?.querySelector('.xterm-accessibility-tree > [role="listitem"]')
  return {
    buffer: region?.__weworkViewportForE2E?.() ?? null,
    firstRow: firstRow?.getAttribute('aria-posinset') ?? null,
    totalRows: firstRow?.getAttribute('aria-setsize') ?? null,
  }
}

export function recordNativeTerminalKey(
  phase: string,
  key: string,
  element: Element | null,
  event?: KeyboardEvent
): void {
  if (!/PageUp|PageDown/.test(key)) return
  samples.push({
    at: new Date().toISOString(),
    phase,
    key,
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    targetFocused: document.activeElement === element,
    ...terminalViewport(element),
    ...(event
      ? {
          event: {
            key: event.key,
            code: event.code,
            keyCode: event.keyCode,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            isTrusted: event.isTrusted,
            targetMatches: event.target === element,
          },
        }
      : {}),
  })
  if (samples.length > 100) samples.shift()
}

export function getNativeTerminalDiagnostics() {
  return {
    samples: [...samples],
    current: terminalViewport(
      document.querySelector(
        '[data-testid="background-terminal-output-panel"] .xterm-helper-textarea'
      )
    ),
  }
}
