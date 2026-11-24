import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

export const SCROLLBAR_DRAG_POSITION_EVENT = 'ui-sdk:scrollbar-drag-position'

// Numeric sources keep exported diagnostics free of application strings and identify each owner.
// 1: virtualizer; 3: shared bottom-distance writer;
// 4: shared content-position writer; 5: controller bottom follow.
export const CONVERSATION_SCROLL_WRITE_SOURCE = {
  virtualizerOffset: 1,
  distanceFromBottom: 3,
  contentPosition: 4,
  controllerBottom: 5,
} as const

type ScrollWriteSource =
  (typeof CONVERSATION_SCROLL_WRITE_SOURCE)[keyof typeof CONVERSATION_SCROLL_WRITE_SOURCE]

const offsetObservers = new WeakMap<HTMLElement, (offset: number) => void>()

export function observeConversationScrollWrites(
  element: HTMLElement,
  onOffset: (offset: number) => void
): () => void {
  offsetObservers.set(element, onOffset)
  return () => {
    if (offsetObservers.get(element) === onOffset) offsetObservers.delete(element)
  }
}

export function recordConversationScrollWrite<T>(
  element: HTMLElement,
  writeSource: ScrollWriteSource,
  targetScrollTop: number | null,
  write: () => T,
  details?: () => Record<string, number | boolean | null>
): T {
  const diagnosticsEnabled = isConversationDiagnosticsEnabled()
  const fromVirtualizer = writeSource === CONVERSATION_SCROLL_WRITE_SOURCE.virtualizerOffset
  if (!diagnosticsEnabled && fromVirtualizer) return write()
  const previousScrollTop = diagnosticsEnabled ? element.scrollTop : 0
  try {
    return write()
  } finally {
    const observer = fromVirtualizer ? undefined : offsetObservers.get(element)
    const scrollTop = observer || diagnosticsEnabled ? element.scrollTop : 0
    // Native scroll events arrive after ResizeObserver. Publish instant external
    // writes first so a virtualizer cannot compensate from its previous offset.
    observer?.(scrollTop)
    if (diagnosticsEnabled) {
      const clientHeight = element.clientHeight
      recordConversationDiagnostic('scroll-write', {
        ...details?.(),
        ...getConversationDiagnosticContext(element),
        writeSource,
        previousScrollTop,
        targetScrollTop,
        appliedCorrection: scrollTop - previousScrollTop,
        scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight,
        clientWidth: element.clientWidth,
        rootHeight: clientHeight,
      })
    }
  }
}
