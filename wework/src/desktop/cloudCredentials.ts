export interface DevicePublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface AuthorizationPollResult {
  status: 'pending' | 'success' | 'declined' | 'failed'
  accessToken?: string
  tokenType?: string
  username?: string
  credentialMode?: 'desktop_refresh' | 'legacy_access_token'
  error?: string
}

export interface RefreshedAccessToken {
  accessToken: string
  tokenType: string
  expiresIn: number
}

interface CloudCredentialFailure {
  ok: false
  error: {
    code: string
    message: string
    status: number | null
  }
}

interface CloudCredentialSuccess<Value> {
  ok: true
  value: Value
}

type CloudCredentialResult<Value> = CloudCredentialSuccess<Value> | CloudCredentialFailure

declare global {
  interface Window {
    weworkElectronCloudCredentials?: {
      getDevicePublicKey(): Promise<DevicePublicKey>
      claimAuthorization(input: {
        apiBaseUrl: string
        sessionId: string
        pollToken: string
      }): Promise<CloudCredentialResult<AuthorizationPollResult>>
      refreshAccessToken(apiBaseUrl: string): Promise<CloudCredentialResult<RefreshedAccessToken>>
      clear(): Promise<void>
    }
  }
}

export class DesktopCloudCredentialError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(code: string, message: string, status: number | null) {
    super(message)
    this.name = 'DesktopCloudCredentialError'
    this.code = code
    this.status = status
  }
}

function bridge() {
  const value = window.weworkElectronCloudCredentials
  if (!value) throw new Error('Desktop cloud credential service is unavailable')
  return value
}

export function getDesktopDevicePublicKey(): Promise<DevicePublicKey> {
  return bridge().getDevicePublicKey()
}

export async function claimDesktopCloudAuthorization(input: {
  apiBaseUrl: string
  sessionId: string
  pollToken: string
}): Promise<AuthorizationPollResult> {
  return unwrap(await bridge().claimAuthorization(input))
}

export async function refreshDesktopCloudAccessToken(
  apiBaseUrl: string
): Promise<RefreshedAccessToken> {
  return unwrap(await bridge().refreshAccessToken(apiBaseUrl))
}

export async function clearDesktopCloudCredentials(): Promise<void> {
  await bridge().clear()
}

function unwrap<Value>(result: CloudCredentialResult<Value>): Value {
  if (result.ok) return result.value
  throw new DesktopCloudCredentialError(
    result.error.code,
    result.error.message,
    result.error.status
  )
}
