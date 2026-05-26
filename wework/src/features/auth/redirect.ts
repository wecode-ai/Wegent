export const POST_LOGIN_REDIRECT_KEY = 'postLoginRedirectPath'
export const LOGIN_PATH = '/login'
export const OIDC_CALLBACK_PATH = '/login/oidc'

export function sanitizeRedirectPath(
  candidate: string | null | undefined,
  disallow: string[] = []
): string | null {
  if (!candidate) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(candidate)
  } catch {
    return null
  }

  const normalized = decoded.trim().replace(/[\t\n\r]/g, '')
  if (!normalized) return null
  if (!normalized.startsWith('/')) return null
  if (normalized.startsWith('//')) return null
  if (normalized.includes('\\')) return null

  const lowerNormalized = normalized.toLowerCase()
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:', 'about:']
  if (dangerousProtocols.some(protocol => lowerNormalized.includes(protocol))) {
    return null
  }

  const [pathPart] = normalized.split(/[?#]/)
  if (disallow.includes(pathPart) || disallow.includes(normalized)) {
    return null
  }

  const pathParts = pathPart.split('/').filter(Boolean)
  const resolvedParts: string[] = []
  for (const part of pathParts) {
    if (part === '..') {
      resolvedParts.pop()
    } else if (part !== '.') {
      resolvedParts.push(part)
    }
  }

  const cleanPath = '/' + resolvedParts.join('/')
  const queryStart = normalized.indexOf('?')
  const fragmentStart = normalized.indexOf('#')

  if (queryStart !== -1) {
    if (fragmentStart !== -1 && fragmentStart > queryStart) {
      return cleanPath + normalized.substring(queryStart, fragmentStart) + normalized.substring(fragmentStart)
    }
    return cleanPath + normalized.substring(queryStart)
  }

  if (fragmentStart !== -1) {
    return cleanPath + normalized.substring(fragmentStart)
  }

  return cleanPath
}

export function getCurrentRedirectTarget(): string | null {
  const currentPath = `${window.location.pathname}${window.location.search}`
  return sanitizeRedirectPath(currentPath, [LOGIN_PATH, OIDC_CALLBACK_PATH])
}

export function redirectToLogin() {
  const redirectTarget = getCurrentRedirectTarget()
  if (redirectTarget) {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
  } else {
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
  }
  window.history.pushState({}, '', LOGIN_PATH)
}
