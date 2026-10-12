export async function cancellableTextGeneration<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new DOMException('Text generation timed out', 'TimeoutError'))
        }, timeoutMs)
  let onAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

export async function textGenerationRequest<T>(
  signal: AbortSignal,
  start: () => Promise<T>,
  cancel: () => Promise<unknown>
): Promise<T> {
  signal.throwIfAborted()
  const abort = () => {
    void cancel().catch(() => console.debug('[Wework] Text generation cancellation failed'))
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await start()
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
