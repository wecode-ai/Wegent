import { completedApiResourceTimings, until } from './plugin-regression-fixture.mjs'

export async function waitForDeliveredCloudCatalog(control, catalogProxy, requestStart = 0) {
  let snapshot, timings, requests
  const observedControl = {
    command: async (...args) => {
      const raw = await control.command(...args)
      snapshot = JSON.parse(raw)
      return raw
    },
  }
  const message = 'The previous cloud catalog request did not finish in the renderer'
  return until(
    async () => {
      timings = await completedApiResourceTimings(observedControl, '/api/models/unified')
      requests = catalogProxy.requests
        .slice(requestStart)
        .filter(entry => entry.method === 'GET' && entry.path === '/api/models/unified')
      const request = requests.at(-1)
      if (!request?.responseCompleted || request.status !== 200) return null
      const receivedAt = Date.parse(request.receivedAt)
      return timings.some(
        timing =>
          Math.floor(timing.startedAt) <= receivedAt && Math.ceil(timing.completedAt) >= receivedAt
      )
        ? request
        : null
    },
    request => Boolean(request),
    message
  ).catch(error => {
    if (error.message === message)
      console.error('[stand-in-model-catalog] Delivery timeout', {
        requests: requests
          ?.slice(-3)
          .map(({ method, path, status, receivedAt, completedAt, responseCompleted }) => ({
            method,
            path,
            status,
            receivedAt,
            completedAt,
            responseCompleted,
          })),
        renderer: {
          timeOrigin: snapshot?.timeOrigin,
          resourceCount: snapshot?.network.length,
          latestCompletion:
            snapshot &&
            Math.max(
              ...snapshot.network.map(
                entry => snapshot.timeOrigin + entry.startTime + entry.duration
              )
            ),
          catalogTimings: timings?.map(({ path, startedAt, completedAt, durationMs }) => ({
            path,
            startedAt,
            completedAt,
            durationMs,
          })),
        },
      })
    throw error
  })
}
