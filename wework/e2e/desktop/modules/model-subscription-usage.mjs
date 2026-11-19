export function modelSubscriptionUsage(planType = 'pro') {
  return {
    plan_type: planType,
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 0,
        reset_at: Math.floor(Date.now() / 1000) + 18_000,
        reset_after_seconds: 18_000,
        limit_window_seconds: 18_000,
      },
      secondary_window: null,
    },
  }
}

export function handleModelSubscriptionUsage(
  request,
  response,
  readUsage = modelSubscriptionUsage
) {
  if (request.method !== 'GET' || request.url?.split('?')[0] !== '/backend-api/wham/usage')
    return false
  const writeUsage = usage => {
    if (response.destroyed) return
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(usage))
  }
  const failUsage = error => {
    console.error('[desktop-e2e] Model usage fixture failed', error)
    if (response.destroyed) return
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'Model usage fixture failed' }))
  }
  try {
    const usage = readUsage()
    if (usage && typeof usage.then === 'function')
      void Promise.resolve(usage).then(writeUsage).catch(failUsage)
    else writeUsage(usage)
  } catch (error) {
    failUsage(error)
  }
  return true
}
