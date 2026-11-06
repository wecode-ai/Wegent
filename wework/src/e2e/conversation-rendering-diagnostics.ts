const TARGETS = {
  workbenches: '[data-testid="desktop-workbench-main"]',
  viewports: '[data-testid="desktop-workbench-content"]',
  frames: '[data-testid="desktop-workbench-scroll-frame"]',
  contents: '[data-testid="desktop-chat-scroll-content"]',
  lists: '[data-conversation-message-list]',
} as const

const STATIC_TEST_IDS = new Set([
  'desktop-workbench-main',
  'desktop-workbench-content',
  'desktop-workbench-scroll-frame',
  'desktop-chat-scroll-content',
  'desktop-chat-scroll',
  'chat-message-scroll-area',
  'desktop-workbench-pane-stack-container',
  'workspace-tab-content-fixed-task',
])

function numberValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function numericFields(value: unknown, keys: string[]) {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(keys.map(key => [key, numberValue(record[key])]))
}

function booleanFields(value: unknown, keys: string[]) {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(
    keys.map(key => [key, typeof record[key] === 'boolean' ? record[key] : null])
  )
}

function jsonNumbers(value: string | null, keys: string[]) {
  if (!value || value === 'null') return null
  try {
    return numericFields(JSON.parse(value), keys)
  } catch {
    return { invalid: true }
  }
}

function staticTestId(value: string | null | undefined): string {
  if (!value) return 'unmarked'
  if (value === 'none' || STATIC_TEST_IDS.has(value)) return value
  return value.startsWith('workbench-pane-') ? 'workbench-pane' : 'other'
}

function elementGeometry(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return {
    tag: element.tagName.toLowerCase(),
    testId: staticTestId(element.dataset.testid),
    connected: element.isConnected,
    hidden: element.hidden,
    inert: element.hasAttribute('inert'),
    ariaHidden: element.getAttribute('aria-hidden') === 'true',
    activePane: element.getAttribute('data-active-workbench-pane') === 'true',
    rect: numericFields(rect, ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']),
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
    clientRectCount: element.getClientRects().length,
    style: {
      display: style.display,
      visibility: style.visibility,
      contentVisibility: style.contentVisibility,
      opacity: style.opacity,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      contain: style.contain,
    },
  }
}

function listInputs(element: HTMLElement) {
  const read = (name: string) => element.getAttribute(`data-conversation-${name}`)
  const boolean = (name: string) => {
    const value = read(name)
    return value === 'true' ? true : value === 'false' ? false : null
  }
  return {
    layoutWidth: numberValue(read('layout-width')),
    messageCount: numberValue(read('message-count')),
    visibleCount: numberValue(read('visible-count')),
    virtualMessages: boolean('virtual-messages'),
    viewportReady: boolean('viewport-ready'),
    virtualizerEnabled: boolean('virtualizer-enabled'),
    virtualRowCount: numberValue(read('virtual-row-count')),
    virtualRange: jsonNumbers(read('virtual-range'), ['startIndex', 'endIndex']),
    scrollRect: jsonNumbers(read('scroll-rect'), ['width', 'height']),
    scrollConnected: boolean('scroll-connected'),
    scrollElement: staticTestId(read('scroll-element')),
  }
}

function listGeometry(element: HTMLElement) {
  const ancestors = []
  for (let node = element.parentElement; node && ancestors.length < 12; node = node.parentElement) {
    ancestors.push(elementGeometry(node))
  }
  const viewport = element.closest<HTMLElement>(TARGETS.viewports)
  return {
    ...elementGeometry(element),
    inputs: listInputs(element),
    viewportContainsList: viewport?.contains(element) ?? false,
    ancestors,
  }
}

function nativeWindowState(value: unknown) {
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    platform: ['darwin', 'win32', 'linux'].includes(String(state.platform))
      ? state.platform
      : 'unknown',
    ...booleanFields(state, [
      'visible',
      'minimized',
      'maximized',
      'fullScreen',
      'focused',
      'dockVisible',
    ]),
    bounds: numericFields(state.bounds, ['x', 'y', 'width', 'height']),
    normalBounds: numericFields(state.normalBounds, ['x', 'y', 'width', 'height']),
  }
}

async function nativeDiagnostics(readNative: (capability: string) => Promise<unknown>) {
  const results = await Promise.allSettled([
    readNative('window.getState'),
    readNative('e2e.getWindowBackgroundPolicy'),
  ])
  return Object.fromEntries(
    results.map((result, index) => [
      index === 0 ? 'window' : 'background',
      result.status === 'rejected'
        ? { status: 'error', name: result.reason instanceof Error ? result.reason.name : 'Error' }
        : {
            status: 'ok',
            value:
              index === 0
                ? nativeWindowState(result.value)
                : booleanFields(result.value, [
                    'backgroundThrottling',
                    'backgroundTimerThrottlingDisabled',
                  ]),
          },
    ])
  )
}

/** Read geometry only when the existing failure/debug command explicitly requests it. */
export async function collectConversationRenderingDiagnostics(
  readNative: (capability: string) => Promise<unknown>
) {
  const elements = Object.fromEntries(
    Object.entries(TARGETS).map(([name, selector]) => {
      const matches = Array.from(document.querySelectorAll<HTMLElement>(selector))
      return [
        name,
        {
          count: matches.length,
          items: matches.slice(0, 16).map(name === 'lists' ? listGeometry : elementGeometry),
        },
      ]
    })
  )
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    document: {
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      widthAtLeast1280: window.innerWidth >= 1280,
      messageCount: document.querySelectorAll('[data-message-id]').length,
      assistantCount: document.querySelectorAll('[data-testid="message-assistant"]').length,
    },
    elements,
    native: await nativeDiagnostics(readNative),
  }
}
