import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
} from '@/desktop/localExecutor'
import { createHttpClient } from '@/api/http'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'

interface WegentRuntimeAuthTokenResponse {
  auth_token: string
  token_type: string
  expires_in?: number
}

export interface LocalExecutorCloudConnection {
  apiBaseUrl?: string
  backendUrl?: string
  socketBaseUrl?: string
  isConnected: boolean
  token: string | null
}

export interface LocalExecutorCloudConnectionResult {
  connected: boolean
  runtimeAuthTokenExpiresIn?: number
}

interface LocalExecutorCloudConnectionOptions {
  isCurrent?: () => boolean
}

const DEFAULT_RUNTIME_AUTH_TOKEN_EXPIRES_IN_SECONDS = 24 * 60 * 60

function normalizeExpiresIn(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_RUNTIME_AUTH_TOKEN_EXPIRES_IN_SECONDS
}

async function issueRuntimeAuthToken(
  apiBaseUrl: string,
  token: string
): Promise<{ authToken: string; expiresIn: number }> {
  const client = createHttpClient({
    baseUrl: apiBaseUrl,
    getToken: () => token,
    redirectOnUnauthorized: false,
  })
  const response = await client.post<WegentRuntimeAuthTokenResponse>(
    '/users/me/wegent-runtime-token'
  )
  const runtimeAuthToken = response.auth_token.trim()
  if (!runtimeAuthToken) {
    throw new Error('Cloud Backend did not return a Wegent runtime token')
  }
  return {
    authToken: runtimeAuthToken,
    expiresIn: normalizeExpiresIn(response.expires_in),
  }
}

export async function applyLocalExecutorCloudConnection(
  { apiBaseUrl, backendUrl, socketBaseUrl, isConnected, token }: LocalExecutorCloudConnection,
  options: LocalExecutorCloudConnectionOptions = {}
): Promise<LocalExecutorCloudConnectionResult> {
  if (!isCloudConnectionUiAvailable()) return { connected: false }
  const isCurrent = options.isCurrent ?? (() => true)
  if (!isCurrent()) return { connected: false }

  if (isConnected && backendUrl && socketBaseUrl && token) {
    if (!apiBaseUrl) {
      throw new Error('Cloud Backend API URL is required for Wegent runtime token issuing')
    }
    const runtimeToken = await issueRuntimeAuthToken(apiBaseUrl, token)
    if (!isCurrent()) return { connected: false }
    await connectLocalExecutorToBackend({
      backendUrl,
      socketBaseUrl,
      authToken: token,
      runtimeAuthToken: runtimeToken.authToken,
      deviceType: 'app',
    })
    return {
      connected: true,
      runtimeAuthTokenExpiresIn: runtimeToken.expiresIn,
    }
  }

  if (!isCurrent()) return { connected: false }
  await disconnectLocalExecutorFromBackend()
  return { connected: false }
}
