import { recordConversationDiagnostic } from '@wegent/collaboration/conversation/conversationDiagnostics'

type RequestEvent = 'search-transcript-request' | 'search-hydration-request'

/** Phases identify actual request admission, completion, failure and cancellation. */
export async function traceConversationSearch<T>(
  name: RequestEvent,
  signal: AbortSignal,
  measurements: Record<string, number>,
  request: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  const record = (phase: 0 | 1 | 2 | 3) =>
    recordConversationDiagnostic(name, {
      ...measurements,
      phase,
      elapsedMs: performance.now() - startedAt,
      requestFailed: name === 'search-transcript-request' && phase === 2,
      historyFailed: name === 'search-hydration-request' && phase === 2,
    })
  const cancel = () => record(3)
  signal.addEventListener('abort', cancel, { once: true })
  record(0)
  try {
    const result = await request()
    if (!signal.aborted) record(1)
    return result
  } catch (error) {
    if (!signal.aborted) record(2)
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
