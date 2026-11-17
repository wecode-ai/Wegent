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
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(readUsage()))
  return true
}
