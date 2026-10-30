import { errorMessage, responseJson, type RuntimeSessionConfig } from './backendConfig'

export interface WebSessionRequest {
  type: 'wework.web-session.request'
  nonce: string
  redirect: string
}

export interface WebSessionFailure {
  type: 'wework.web-session.error'
  status: number
  nonce: string
}

interface WebSessionGrant {
  code: string
  user_id: number
  expires_at: number
}

export class WebIssueSessionError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'WebIssueSessionError'
  }
}

export function parseWebSessionMessage(
  data: string,
  sourceUrl: string,
  bootstrapUrl: string,
  mainDocumentUrl: string = sourceUrl
): WebSessionRequest | WebSessionFailure | null {
  try {
    const source = new URL(sourceUrl)
    const expected = new URL(bootstrapUrl)
    const document = new URL(mainDocumentUrl)
    const sourceIsOrigin = source.pathname === '/' && !source.search && !source.hash
    if (
      source.origin !== expected.origin ||
      source.username ||
      source.password ||
      !matchesBootstrapDocument(document, expected) ||
      (!sourceIsOrigin && !matchesBootstrapDocument(source, expected))
    ) {
      return null
    }
    const message = JSON.parse(data) as Record<string, unknown>
    if (message.type === 'wework.web-session.error') {
      return typeof message.status === 'number' &&
        typeof message.nonce === 'string' &&
        /^[a-f0-9]{64}$/.test(message.nonce)
        ? { type: message.type, status: message.status, nonce: message.nonce }
        : null
    }
    if (
      message.type !== 'wework.web-session.request' ||
      typeof message.nonce !== 'string' ||
      !/^[a-f0-9]{64}$/.test(message.nonce) ||
      message.redirect !== expected.searchParams.get('redirect')
    ) {
      return null
    }
    return { type: message.type, nonce: message.nonce, redirect: message.redirect as string }
  } catch {
    return null
  }
}

function matchesBootstrapDocument(document: URL, expected: URL): boolean {
  return (
    document.origin === expected.origin &&
    document.pathname === expected.pathname &&
    document.search === expected.search &&
    !document.hash &&
    !document.username &&
    !document.password
  )
}

export async function createWebIssueSession(
  config: RuntimeSessionConfig,
  request: WebSessionRequest,
  userId: number,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(`${config.apiBaseUrl}/auth/wework/web-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ nonce: request.nonce, redirect: request.redirect }),
    signal,
  })
  const body = await responseJson<WebSessionGrant>(response)
  if (!response.ok) {
    throw new WebIssueSessionError(response.status, errorMessage(body, response.status))
  }
  if (
    body.user_id !== userId ||
    typeof body.code !== 'string' ||
    !body.code ||
    !Number.isFinite(body.expires_at) ||
    body.expires_at * 1000 <= Date.now()
  ) {
    throw new WebIssueSessionError(409, 'Web 授权与当前登录身份不一致或已过期')
  }
  const data = JSON.stringify({
    type: 'wework.web-session.grant',
    nonce: request.nonce,
    code: body.code,
  })
  return `window.dispatchEvent(new MessageEvent('message', {data: ${JSON.stringify(data)}}));true;`
}
