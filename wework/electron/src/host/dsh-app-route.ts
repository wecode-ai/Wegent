const WEWORK_APP_PATH = '/wework/app'

export function resolveDshAppRoute(baseUrl: string, route: string): URL {
  const target = new URL(baseUrl)
  const routePath = route.replace(/^\/+/, '')
  target.pathname = `${WEWORK_APP_PATH}/${routePath}`
  target.search = ''
  target.hash = ''
  return target
}
