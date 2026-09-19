const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 30000]

export function createBatchQueue({
  sendBatch,
  batchSize = 20,
  flushIntervalMs = 5000,
  maxQueueSize = 500,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  let activeBatch = null
  let disposePromise = null
  let disposed = false
  let events = []
  let flushTimer = null
  let processing = null
  let retryTimer = null
  const metrics = {
    droppedEvents: 0,
    lastFailureAt: null,
    lastFailureCode: null,
    lastSuccessAt: null,
    permanentFailedBatches: 0,
    retries: 0,
    sentBatches: 0,
    sentEvents: 0,
  }

  return Object.freeze({
    enqueue(event) {
      if (disposed) return false

      events.push(event)
      enforceQueueLimit()
      if (!activeBatch && !processing) {
        if (events.length >= batchSize) {
          void flush()
        } else {
          scheduleFlush()
        }
      }
      return true
    },

    flush,

    status() {
      return {
        queuedEvents: events.length,
        droppedEvents: metrics.droppedEvents,
        sentBatches: metrics.sentBatches,
        sentEvents: metrics.sentEvents,
        retries: metrics.retries,
        permanentFailedBatches: metrics.permanentFailedBatches,
        lastSuccessAt: metrics.lastSuccessAt,
        lastFailureAt: metrics.lastFailureAt,
        lastFailureCode: metrics.lastFailureCode,
      }
    },

    dispose(options) {
      if (disposePromise) return disposePromise

      disposed = true
      clearFlushTimer()
      clearRetryTimer()
      const finalFlush = processing ?? flush({ allowDisposed: true })
      disposePromise = completeWithin(finalFlush, options?.timeoutMs ?? 1000).then(() => {
        clearFlushTimer()
        clearRetryTimer()
        events = []
        activeBatch = null
      })
      return disposePromise
    },
  })

  function flush({ allowDisposed = false } = {}) {
    clearFlushTimer()
    if ((disposed && !allowDisposed) || retryTimer || processing || events.length === 0) {
      return processing ?? Promise.resolve()
    }

    if (!activeBatch) {
      activeBatch = {
        eventCount: Math.min(batchSize, events.length),
        retryCount: 0,
      }
    }

    const batch = activeBatch
    const operation = Promise.resolve()
      .then(() => sendBatch(events.slice(0, batch.eventCount)))
      .then(
        result => handleBatchResult(batch, result),
        () => handleBatchResult(batch, { status: 'retryable_error', code: 'posthog_unavailable' })
      )
    processing = operation

    void operation.finally(() => {
      if (processing !== operation) return
      processing = null
      if (!disposed && !activeBatch) scheduleNextFlush()
    })
    return operation
  }

  function handleBatchResult(batch, result) {
    if (activeBatch !== batch) return

    if (result?.status === 'accepted') {
      removeActiveBatch()
      metrics.sentBatches += 1
      metrics.sentEvents += batch.eventCount
      metrics.lastSuccessAt = now()
      return
    }

    const code = typeof result?.code === 'string' ? result.code : 'posthog_unavailable'
    metrics.lastFailureAt = now()
    metrics.lastFailureCode = code
    if (
      result?.status === 'retryable_error' &&
      !disposed &&
      batch.retryCount < retryDelaysMs.length
    ) {
      const delay = retryDelaysMs[batch.retryCount]
      batch.retryCount += 1
      metrics.retries += 1
      retryTimer = createTimer(() => {
        retryTimer = null
        void flush()
      }, delay)
      return
    }

    removeActiveBatch()
    metrics.permanentFailedBatches += 1
  }

  function scheduleNextFlush() {
    if (events.length === 0) return
    if (events.length >= batchSize) {
      void flush()
      return
    }
    scheduleFlush()
  }

  function scheduleFlush() {
    if (flushTimer || retryTimer || events.length === 0 || disposed) return
    flushTimer = createTimer(() => {
      flushTimer = null
      void flush()
    }, flushIntervalMs)
  }

  function enforceQueueLimit() {
    while (events.length > maxQueueSize) {
      const protectedEvents = activeBatch?.eventCount ?? 0
      events.splice(protectedEvents, 1)
      metrics.droppedEvents += 1
    }
  }

  function removeActiveBatch() {
    events.splice(0, activeBatch.eventCount)
    activeBatch = null
  }

  function completeWithin(promise, timeoutMs) {
    return new Promise(resolve => {
      let settled = false
      const timer = createTimer(finish, timeoutMs)
      Promise.resolve(promise).then(finish, finish)

      function finish() {
        if (settled) return
        settled = true
        clearTimer(timer)
        resolve()
      }
    })
  }

  function clearFlushTimer() {
    if (!flushTimer) return
    clearTimer(flushTimer)
    flushTimer = null
  }

  function clearRetryTimer() {
    if (!retryTimer) return
    clearTimer(retryTimer)
    retryTimer = null
  }

  function createTimer(callback, delay) {
    const timer = setTimer(callback, delay)
    timer?.unref?.()
    return timer
  }
}
