const WEWORK_APP_PATH = '/wework/app'

export function resolveDshAppRoute(baseUrl: string, route: string): URL {
  const content = new URL(route, baseUrl)
  const target = new URL(baseUrl)
  const routePath = content.pathname.replace(/^\/+/, '')
  target.pathname = `${WEWORK_APP_PATH}/${routePath}`
  target.search = content.search
  target.hash = content.hash
  return target
}
