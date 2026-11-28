import type { DesktopHostEvent } from '@/api/dsh/desktopHost'

const BROWSER_AGENT_TAB_ICON_SELECTOR =
  '[data-testid^="right-workspace-browser-tab-"][aria-selected="true"] [data-testid$="-agent-icon"]'
const PERSISTENCE_MS = 1_000

interface CursorSnapshot {
  cursorPresent: boolean
  visible: string | null
  style: string
  tabIconCount: number
}

type ObservedCursorSnapshot = CursorSnapshot & { observedAtUnixMs: number }

interface ObservationDependencies {
  subscribe: (listener: (event: DesktopHostEvent) => void) => () => void
  readSnapshot?: () => CursorSnapshot
  observeDom?: (listener: () => void) => () => void
}

/** Read the production overlay owned by this browser, including its hidden state. */
export function readEmbeddedBrowserCursorSnapshot(label: string): CursorSnapshot {
  const host = Array.from(
    document.querySelectorAll<HTMLElement>('[data-wework-browser-webview]')
  ).find(element => element.dataset.weworkBrowserWebview === label)
  const cursor = host?.querySelector<HTMLElement>('[data-testid="workspace-browser-agent-cursor"]')
  return {
    cursorPresent: Boolean(cursor),
    visible: cursor?.dataset.visible ?? null,
    style: cursor?.getAttribute('style') ?? '',
    tabIconCount: document.querySelectorAll(BROWSER_AGENT_TAB_ICON_SELECTOR).length,
  }
}

function observeCursorDom(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-visible', 'style', 'aria-selected'],
  })
  return () => observer.disconnect()
}

/** Register before the click; keep bounded renderer evidence until the control client reads it. */
export function createEmbeddedBrowserCursorObservation(
  label: string,
  timeoutMs: number,
  {
    subscribe,
    readSnapshot = () => readEmbeddedBrowserCursorSnapshot(label),
    observeDom = observeCursorDom,
  }: ObservationDependencies
) {
  if (!label.trim() || !Number.isFinite(timeoutMs) || timeoutMs <= PERSISTENCE_MS) {
    throw new Error('Browser cursor observation requires a label and a bounded step timeout')
  }
  let running = false
  let moveSequence: number | null = null
  let cursorEmittedAtUnixMs: number | null = null
  let cursorReceivedAtUnixMs: number | null = null
  let clickFinishedAtUnixMs: number | null = null
  let idleReceivedAtUnixMs: number | null = null
  let cursorHiddenAtUnixMs: number | null = null
  let firstVisible: ObservedCursorSnapshot | null = null
  let afterClick: (ObservedCursorSnapshot & { elapsedMs: number }) | null = null
  let settled = false
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined
  let stopEvents = () => {}
  let stopDom = () => {}
  let resolve!: (value: string) => void
  let reject!: (error: Error) => void
  const result = new Promise<string>((resolveResult, rejectResult) => {
    resolve = resolveResult
    reject = rejectResult
  })
  // A failed observation can precede the runner's finish command; preserve its rejection.
  void result.catch(() => {})
  const cleanup = () => {
    clearTimeout(persistenceTimer)
    clearTimeout(deadline)
    stopEvents()
    stopDom()
  }
  const fail = (message: string) => {
    if (settled) return
    settled = true
    cleanup()
    reject(
      new Error(
        `${message}: ${JSON.stringify({ label, moveSequence, clickFinishedAtUnixMs, cursorHiddenAtUnixMs, firstVisible, afterClick })}`
      )
    )
  }
  const capture = () => {
    if (settled || moveSequence === null || clickFinishedAtUnixMs === null) return
    const snapshot = readSnapshot()
    if (
      !firstVisible &&
      snapshot.cursorPresent &&
      snapshot.visible === 'true' &&
      snapshot.tabIconCount > 0
    ) {
      firstVisible = { ...snapshot, observedAtUnixMs: Date.now() }
    }
    if (
      firstVisible &&
      afterClick === null &&
      (!snapshot.cursorPresent || snapshot.visible !== 'true')
    ) {
      fail('The host AI cursor disappeared before the one-second click observation')
      return
    }
    if (
      cursorHiddenAtUnixMs !== null &&
      afterClick !== null &&
      snapshot.cursorPresent &&
      snapshot.visible === 'false' &&
      snapshot.tabIconCount === 0
    ) {
      settled = true
      cleanup()
      resolve(
        JSON.stringify({
          label,
          moveSequence,
          cursorEmittedAtUnixMs,
          cursorReceivedAtUnixMs,
          clickFinishedAtUnixMs,
          idleReceivedAtUnixMs,
          cursorHiddenAtUnixMs,
          firstVisible,
          afterClick,
          hidden: { ...snapshot, observedAtUnixMs: Date.now() },
        })
      )
    }
  }
  const deadline = setTimeout(
    () => fail('Timed out observing the browser click cursor and idle hide'),
    timeoutMs
  )
  stopDom = observeDom(capture)
  stopEvents = subscribe(event => {
    if (settled || event.type !== 'browser.event') return
    const browserEvent = event.payload as { type?: string; payload?: Record<string, unknown> }
    const payload = browserEvent.payload
    if (!payload || payload.label !== label) return
    if (browserEvent.type === 'agent-state' && payload.action === 'click') {
      if (payload.status === 'running') running = true
      else if (running && payload.status === 'idle' && clickFinishedAtUnixMs === null) {
        clickFinishedAtUnixMs = Number(payload.createdAtUnixMs)
        idleReceivedAtUnixMs = Date.now()
        persistenceTimer = setTimeout(() => {
          afterClick = {
            ...readSnapshot(),
            observedAtUnixMs: Date.now(),
            elapsedMs: Date.now() - idleReceivedAtUnixMs!,
          }
          if (!firstVisible || !afterClick.cursorPresent || afterClick.visible !== 'true') {
            fail('The host AI cursor was not visible one second after the click')
            return
          }
          capture()
        }, PERSISTENCE_MS)
        capture()
      } else if (running && payload.status !== 'running' && payload.status !== 'idle') {
        fail('The observed browser click did not finish idle')
      }
    }
    if (browserEvent.type === 'agent-cursor' && running) {
      if (payload.visible === true && moveSequence === null) {
        moveSequence = Number(payload.moveSequence)
        cursorEmittedAtUnixMs = Number(payload.createdAtUnixMs)
        cursorReceivedAtUnixMs = Date.now()
      } else if (payload.visible === true && payload.moveSequence !== moveSequence) {
        fail('Another cursor movement interrupted the observed browser click')
      } else if (payload.visible === false && payload.moveSequence === moveSequence) {
        cursorHiddenAtUnixMs = Number(payload.createdAtUnixMs)
        capture()
      }
    }
  })

  return { result, cancel: () => fail('Browser cursor observation cancelled') }
}
