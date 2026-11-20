window.__ModuleLoader__.load({
  id: '@wegent/dsh-app-wework',
  chunk: 'client.backend-request.js',
  factory: () => {
    const PLUGIN_BACKEND_PATH = '/wework/plugins/v1/rpc'
    // Plugin clients call their backend as soon as they mount, which can race the
    // backend's own registration. Retry only calls that provably never ran.
    const PLUGIN_BACKEND_RETRY_DELAYS_MS = [100, 300, 700, 1500, 2000, 3000, 3000, 4000]
    async function requestPluginBackend(fetchImpl, body, assertActive, firstBody) {
      for (let attempt = 0; ; attempt += 1) {
        assertActive()
        try {
          return await sendPluginBackend(fetchImpl, body, attempt === 0, firstBody)
        } catch (error) {
          const delay = PLUGIN_BACKEND_RETRY_DELAYS_MS[attempt]
          if (delay === undefined || !backendMayStillStart(error)) throw error
          assertActive()
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    async function sendPluginBackend(fetchImpl, body, prepared, firstBody) {
      let response
      try {
        response = await fetchImpl(PLUGIN_BACKEND_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: prepared ? firstBody : JSON.stringify(body),
        })
      } catch (cause) {
        const error = new Error('Plugin backend is unreachable', { cause })
        error.code = 'backend_unreachable'
        throw error
      }
      const payload = await response.json()
      if (!response.ok || !payload?.ok) {
        const error = new Error(
          payload?.error?.message || `Plugin backend request failed: ${response.status}`
        )
        error.code = payload?.error?.code ?? 'backend_failed'
        error.retryable = Boolean(payload?.error?.retryable)
        throw error
      }
      return payload.result
    }

    function backendMayStillStart(error) {
      return error?.code === 'plugin_not_found'
    }

    return { requestPluginBackend }
  },
})
