import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

// Numeric sources keep exported diagnostics free of application strings and identify each owner.
// 1: virtualizer; 3: shared bottom-distance writer;
// 4: shared content-position writer; 5: controller bottom follow;
// 10: workbench scrollbar pointer; 11: workbench scrollbar keyboard.
export const CONVERSATION_SCROLL_WRITE_SOURCE = {
  virtualizerOffset: 1,
  distanceFromBottom: 3,
  contentPosition: 4,
  controllerBottom: 5,
  scrollbarPointer: 10,
  scrollbarKeyboard: 11,
} as const

type ScrollWriteSource =
  (typeof CONVERSATION_SCROLL_WRITE_SOURCE)[keyof typeof CONVERSATION_SCROLL_WRITE_SOURCE]

export function recordConversationScrollWrite<T>(
  element: HTMLElement,
  writeSource: ScrollWriteSource,
  targetScrollTop: number | null,
  write: () => T,
  details?: () => Record<string, number | boolean | null>
): T {
  if (!isConversationDiagnosticsEnabled()) return write()
  const previousScrollTop = element.scrollTop
  try {
    return write()
  } finally {
    const scrollTop = element.scrollTop
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
