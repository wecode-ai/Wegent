export interface RuntimeReadOptions {
  signal?: AbortSignal
}

export function cancelledRuntimeRead(): DOMException {
  return new DOMException('Transcript read cancelled', 'AbortError')
}

/** Abandon a read even when a remote transport cannot cancel its provider. */
export function abortableRuntimeRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelledRuntimeRead())
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelledRuntimeRead())
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export interface SharedRuntimeRead<T> {
  promise: Promise<T>
  controller: AbortController
  consumers: number
}

/** A view releases only its subscription; other views keep the shared read alive. */
export function subscribeRuntimeRead<T>(
  read: SharedRuntimeRead<T>,
  signal?: AbortSignal
): Promise<T> {
  read.consumers += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    read.consumers -= 1
    if (read.consumers === 0) read.controller.abort()
  }
  if (!signal) {
    // Preserve the canonical promise identity used by shared snapshot consumers.
    void read.promise.then(release, release)
    return read.promise
  }
  // Release synchronously so a replacement subscriber cannot join an abandoned read.
  signal.addEventListener('abort', release, { once: true })
  if (signal.aborted) release()
  return abortableRuntimeRead(read.promise, signal).finally(() => {
    signal.removeEventListener('abort', release)
    release()
  })
}
