/** A provider explicitly publishes ordered activation; other cursor fields stay opaque. */
export async function initializeObservation(registry, providerId, source, options = {}) {
  const freshSource = { ...source }
  delete freshSource.boundary
  const checkpoint = await registry.call(providerId, 'initialize', freshSource, {
    ...options,
    initializationMode: 'fresh',
  })
  const boundary = checkpoint.activationBoundary
  if (
    boundary !== undefined &&
    (typeof boundary?.partition !== 'string' ||
      !boundary.partition ||
      !Number.isSafeInteger(boundary.sequence) ||
      boundary.sequence < 0)
  )
    throw Object.assign(new Error('Invalid observation activation boundary'), {
      code: 'connection_invalid_activation',
    })
  return { checkpoint, source: { ...freshSource, ...(boundary === undefined ? {} : { boundary }) } }
}

/** Drain a bounded provider cycle in Node; checkpoint and events commit together. */
export async function collectObservation(registry, providerId, input, { signal } = {}) {
  const events = []
  let checkpoint = input.checkpoint
  let resourceStates
  let recoveryDetails = {}
  const maxPages =
    registry.entries?.get(providerId)?.provider.collectionPagination === 'staged' ? 8 : 1
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted()
    let result
    try {
      result = await registry.call(
        providerId,
        'collect',
        {
          source: input.source,
          checkpoint: structuredClone(checkpoint),
          committedCheckpoint: structuredClone(input.checkpoint),
          force: input.force === true,
          ...(input.recover === true && page === 0 ? { recover: true } : {}),
        },
        { signal }
      )
    } catch (error) {
      signal?.throwIfAborted()
      if (page === 0) throw error
      return {
        events,
        nextCheckpoint: checkpoint,
        hasMore: true,
        resourceStates,
        ...recoveryDetails,
        errorCode: error.code ?? 'connection_collect_failed',
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }
    }
    signal?.throwIfAborted()
    if (events.length && events.length + result.events.length > 1000)
      return {
        events,
        nextCheckpoint: checkpoint,
        hasMore: true,
        resourceStates,
        ...recoveryDetails,
      }
    events.push(...result.events)
    checkpoint = result.nextCheckpoint
    resourceStates = result.resourceStates ?? resourceStates
    if (result.recovery) recoveryDetails = { recovery: result.recovery, gap: result.gap ?? null }
    if (!result.hasMore || events.length >= 1000)
      return {
        events,
        nextCheckpoint: checkpoint,
        hasMore: result.hasMore,
        resourceStates,
        ...recoveryDetails,
        ...(Number.isSafeInteger(result.nextPollAt) ? { nextPollAt: result.nextPollAt } : {}),
      }
  }
  return { events, nextCheckpoint: checkpoint, hasMore: true, resourceStates, ...recoveryDetails }
}
