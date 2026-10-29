const AUTO_UPDATE_ENDPOINT = '/plugins/installed/auto-update-batch'

function httpEvents(snapshot, apiBaseUrl) {
  return (snapshot.logs ?? []).flatMap((log, index) =>
    (log.args ?? []).flatMap(argument => {
      if (typeof argument !== 'string') return []
      let event
      try {
        event = JSON.parse(argument)
      } catch {
        return []
      }
      if (
        typeof event?.baseUrl !== 'string' ||
        event.baseUrl.replace(/\/+$/, '') !== apiBaseUrl.replace(/\/+$/, '') ||
        typeof event.request_id !== 'string' ||
        !event.request_id ||
        typeof event.endpoint !== 'string'
      ) {
        return []
      }
      return [{ ...event, index }]
    })
  )
}

function completedRequest(events, started) {
  const response = events.find(
    event =>
      event.index > started.index &&
      event.phase === 'response_received' &&
      event.request_id === started.request_id &&
      event.method === started.method &&
      event.endpoint === started.endpoint
  )
  return response?.status === 200 ? response : null
}

function deviceEndpoint(event, pathname, deviceId) {
  if (!event.endpoint.startsWith('/')) return false
  try {
    const url = new URL(event.endpoint, 'http://renderer.invalid')
    return url.pathname === pathname && url.searchParams.get('device_id') === deviceId
  } catch {
    return false
  }
}

export function isPluginStartupAutoUpdateReady(snapshot, { apiBaseUrl, deviceId }) {
  const idle = snapshot.idleTasks
  if (
    typeof apiBaseUrl !== 'string' ||
    !apiBaseUrl ||
    typeof deviceId !== 'string' ||
    !deviceId ||
    idle?.started !== true ||
    idle.running !== false ||
    !Array.isArray(idle.pendingTaskIds) ||
    idle.pendingTaskIds.length > 0
  ) {
    return false
  }

  const events = httpEvents(snapshot, apiBaseUrl)
  const started = events.filter(event => event.phase === 'request_started')
  const catalogs = started.filter(
    event => event.method === 'GET' && deviceEndpoint(event, '/plugins/marketplace', deviceId)
  )
  const batches = started.filter(
    event =>
      event.method === 'POST' &&
      event.endpoint === AUTO_UPDATE_ENDPOINT &&
      catalogs.some(catalog => {
        const response = completedRequest(events, catalog)
        return response && response.index < event.index
      })
  )
  if (batches.length === 0) return false

  // The idle task awaits both its update batch and any subsequent full device sync.
  const requests = started.filter(
    event =>
      event.index >= batches[0].index &&
      event.method === 'POST' &&
      (event.endpoint === AUTO_UPDATE_ENDPOINT ||
        deviceEndpoint(event, '/plugins/installed/sync-device', deviceId))
  )
  return requests.every(request => completedRequest(events, request))
}
