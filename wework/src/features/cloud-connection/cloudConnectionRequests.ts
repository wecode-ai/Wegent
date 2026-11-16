import { ApiError, createHttpClient } from '@/api/http'
import { claimDesktopCloudAuthorization, type DevicePublicKey } from '@/desktop/cloudCredentials'
import { raceWithTimeout } from '@/lib/promise-timeout'
import type { User } from '@/types/api'
import type { CloudCredentialMode, CloudConnectionRuntimeConfig } from './cloudConnectionStorage'

interface WeworkAuthSessionCreateResponse {
  session_id: string
  poll_token: string
  authorize_url: string
  web_url: string
  expires_at: number
  poll_interval_seconds: number
}

interface WeworkAuthSessionPollResponse {
  status: 'pending' | 'success' | 'declined' | 'failed'
  accessToken?: string
  tokenType?: string
  username?: string
  credentialMode?: CloudCredentialMode
  error?: string
}

interface WeworkCloudConfigResponse {
  web_url?: unknown
  socket_url?: unknown
}

function createCloudClient(config: CloudConnectionRuntimeConfig, token: string | null) {
  return createHttpClient({
    baseUrl: config.apiBaseUrl,
    getToken: () => token,
    redirectOnUnauthorized: false,
  })
}

function cloudRequestUrl(config: CloudConnectionRuntimeConfig, endpoint: string): string {
  return `${config.apiBaseUrl}${endpoint}`
}

export function rawErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || `HTTP ${error.status}`
  if (error instanceof Error && error.message) return error.message
  return 'Cloud connection failed'
}

function isDesktopHttpPermissionError(error: unknown): boolean {
  const message = rawErrorMessage(error).toLowerCase()
  return message.includes('scope') || message.includes('not allowed') || message.includes('denied')
}

function cloudStepErrorMessage(
  stage: string,
  config: CloudConnectionRuntimeConfig,
  endpoint: string,
  error: unknown
): string {
  const url = cloudRequestUrl(config, endpoint)
  if (isDesktopHttpPermissionError(error)) {
    return `${stage}失败（${url}）：桌面端 HTTP 权限拦截了这个 Backend 地址。请重启 App 后再试。`
  }
  return `${stage}失败（${url}）：${rawErrorMessage(error)}`
}

async function runCloudRequest<T>(
  stage: string,
  config: CloudConnectionRuntimeConfig,
  endpoint: string,
  request: () => Promise<T>,
  options: {
    preserveErrorCodes?: string[]
    preserveStatuses?: number[]
    timeoutMs?: number
  } = {}
): Promise<T> {
  const url = cloudRequestUrl(config, endpoint)
  console.info('[CloudConnection] request start', { stage, url })
  try {
    const response = await raceWithTimeout(request(), options.timeoutMs, timeoutMs => {
      return new Error(`Request timed out after ${timeoutMs}ms`)
    })
    console.info('[CloudConnection] request success', { stage, url })
    return response
  } catch (error) {
    console.error('[CloudConnection] request failed', { stage, url, error })
    if (
      error instanceof ApiError &&
      ((typeof error.errorCode === 'string' &&
        options.preserveErrorCodes?.includes(error.errorCode)) ||
        options.preserveStatuses?.includes(error.status))
    ) {
      throw error
    }
    throw new Error(cloudStepErrorMessage(stage, config, endpoint, error), { cause: error })
  }
}

export async function checkCloudHealth(config: CloudConnectionRuntimeConfig): Promise<void> {
  const client = createCloudClient(config, null)
  await runCloudRequest('健康检查', config, '/health', () =>
    client.get('/health', { redirectOnUnauthorized: false })
  )
}

export async function fetchCloudConfig(
  config: CloudConnectionRuntimeConfig,
  timeoutMs?: number
): Promise<{ webUrl: string; socketUrl?: string }> {
  const client = createCloudClient(config, null)
  const metadata = await runCloudRequest(
    '读取云端配置',
    config,
    '/auth/wework/config',
    () =>
      client.get<WeworkCloudConfigResponse>('/auth/wework/config', {
        redirectOnUnauthorized: false,
      }),
    { timeoutMs }
  )
  if (typeof metadata.web_url !== 'string' || !metadata.web_url.trim()) {
    throw new Error('Cloud Backend did not provide a Web URL')
  }
  const socketUrl =
    typeof metadata.socket_url === 'string' && metadata.socket_url.trim()
      ? metadata.socket_url.trim()
      : undefined
  return {
    webUrl: metadata.web_url.replace(/\/+$/, ''),
    socketUrl,
  }
}

export async function fetchCloudUser(
  config: CloudConnectionRuntimeConfig,
  token: string,
  timeoutMs?: number
): Promise<User> {
  const client = createCloudClient(config, token)
  return runCloudRequest(
    '读取云端用户',
    config,
    '/users/me',
    () => client.get<User>('/users/me', { redirectOnUnauthorized: false }),
    { preserveStatuses: [401], timeoutMs }
  )
}

export async function createWeworkAuthSession(
  config: CloudConnectionRuntimeConfig,
  devicePublicKey: DevicePublicKey
): Promise<WeworkAuthSessionCreateResponse> {
  const client = createCloudClient(config, null)
  return runCloudRequest('创建云端授权会话', config, '/auth/wework/sessions', () =>
    client.post<WeworkAuthSessionCreateResponse>('/auth/wework/sessions', {
      device_public_key: devicePublicKey,
    })
  )
}

export async function pollWeworkAuthSession(
  config: CloudConnectionRuntimeConfig,
  session: WeworkAuthSessionCreateResponse,
  authorizationId: string
): Promise<WeworkAuthSessionPollResponse> {
  const endpoint = `/auth/wework/sessions/${encodeURIComponent(session.session_id)}/poll`
  return runCloudRequest('等待云端授权', config, endpoint, () =>
    claimDesktopCloudAuthorization({
      authorizationId,
      sessionId: session.session_id,
      pollToken: session.poll_token,
    })
  )
}
