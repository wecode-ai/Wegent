/** The token authorizes only one Backend-owned source lease. */
export function cloudObservationClient(backendUrl, collectorToken, fetchRequest = fetch) {
  const endpoint = new URL(`${backendUrl.replace(/\/+$/, '')}/api/runtime-observations/collector`)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Invalid observation Backend address')
  return async (action, input = {}) => {
    const response = await fetchRequest(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${collectorToken}` },
      body: JSON.stringify({ ...input, action }),
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok)
      throw Object.assign(new Error(`Observation Backend returned HTTP ${response.status}`), {
        code:
          response.status === 409 ? 'observation_lease_lost' : 'observation_backend_unavailable',
      })
    return response.json()
  }
}

/** A caller runs this inside the user's DSH sandbox with its read capability adapter. */
export async function runCloudObservation(request, collect, { expectedOwnerId } = {}) {
  const { observation, ownerId } = await request('read_lease')
  if (expectedOwnerId !== undefined && ownerId !== expectedOwnerId)
    throw Object.assign(new Error('Observation account changed'), {
      code: 'observation_owner_changed',
    })
  if (!observation?.source || !observation.checkpoint || !observation.lease)
    throw Object.assign(new Error('Observation lease is unavailable'), {
      code: 'observation_lease_lost',
    })
  let renewal = Promise.resolve()
  let renewalError
  const collection = new AbortController()
  const timer = setInterval(() => {
    if (renewalError) return
    renewal = renewal
      .then(() => request('renew'))
      .catch(error => {
        renewalError = error
        collection.abort(error)
      })
  }, 20000)
  timer.unref?.()
  let page
  let failure
  try {
    page = await collect(
      observation.source.providerId,
      {
        source: observation.source,
        checkpoint: observation.checkpoint,
        force: observation.lease.forceVersion > observation.collectedForceVersion,
      },
      collection.signal
    )
  } catch (error) {
    failure = error
  } finally {
    clearInterval(timer)
    await renewal
  }
  if (renewalError) throw renewalError
  if (failure)
    return request('fail', {
      errorCode: failure.code ?? 'connection_collect_failed',
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    })
  return request('commit', { page })
}
