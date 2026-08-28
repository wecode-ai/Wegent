import { createHash, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface EncryptionProvider {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface StoredCloudCredential {
  version: 1
  apiBaseUrl: string
  publicKey: DevicePublicKey
  encryptedPrivateKey: string
  encryptedRefreshToken: string
}

export interface DevicePublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface AuthorizationPollInput {
  apiBaseUrl: string
  sessionId: string
  pollToken: string
}

export interface AuthorizationPollResult {
  status: 'pending' | 'success' | 'declined' | 'failed'
  accessToken?: string
  tokenType?: string
  username?: string
  error?: string
}

export interface RefreshedAccessToken {
  accessToken: string
  tokenType: string
  expiresIn: number
}

export class CloudCredentialError extends Error {
  constructor(
    readonly code: 'credentials_unavailable' | 'cloud_auth_expired' | 'request_failed',
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'CloudCredentialError'
  }
}

export class CloudCredentialService {
  private operation = Promise.resolve()

  constructor(
    private readonly dataDirectory: string,
    private readonly encryption: EncryptionProvider,
    private readonly request: typeof fetch = fetch
  ) {}

  devicePublicKey(): Promise<DevicePublicKey> {
    return this.serial(async () => {
      const stored = await this.readCredential()
      if (stored) return stored.publicKey
      const generated = this.generateCredential()
      await this.writeCredential(generated)
      return generated.publicKey
    })
  }

  claimAuthorization(input: AuthorizationPollInput): Promise<AuthorizationPollResult> {
    return this.serial(async () => {
      const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl)
      const endpoint = `${apiBaseUrl}/auth/wework/sessions/${encodeURIComponent(
        input.sessionId
      )}/poll?poll_token=${encodeURIComponent(input.pollToken)}`
      const response = await this.request(endpoint, { method: 'GET' })
      const payload = await responseJson(response)
      if (!response.ok) {
        throw requestError(response.status, payload)
      }
      const status = stringValue(payload.status)
      if (!isPollStatus(status)) {
        throw new CloudCredentialError('request_failed', 'Invalid authorization response')
      }
      if (status !== 'success') {
        return {
          status,
          error: optionalString(payload.error),
        }
      }
      const accessToken = requiredString(payload.access_token, 'access token')
      const refreshToken = requiredString(payload.refresh_token, 'refresh token')
      const existing = await this.readCredential()
      const credential = existing ?? this.generateCredential(apiBaseUrl)
      await this.writeCredential({
        ...credential,
        apiBaseUrl,
        encryptedRefreshToken: this.encrypt(refreshToken),
      })
      return {
        status,
        accessToken,
        tokenType: optionalString(payload.token_type),
        username: optionalString(payload.username),
      }
    })
  }

  refreshAccessToken(apiBaseUrl: string): Promise<RefreshedAccessToken> {
    return this.serial(async () => {
      const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl)
      const credential = await this.readCredential()
      if (!credential || credential.apiBaseUrl !== normalizedApiBaseUrl) {
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Desktop cloud credentials are unavailable'
        )
      }
      const refreshToken = this.decrypt(credential.encryptedRefreshToken)
      if (!refreshToken) {
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Desktop cloud credentials are incomplete'
        )
      }
      const endpoint = `${normalizedApiBaseUrl}/auth/wework/refresh`
      const proof = createDeviceProof(
        this.decrypt(credential.encryptedPrivateKey),
        credential.publicKey,
        refreshToken,
        new URL(endpoint).pathname
      )
      const response = await this.request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: refreshToken,
          proof,
        }),
      })
      const payload = await responseJson(response)
      if (!response.ok) {
        throw requestError(response.status, payload)
      }
      return {
        accessToken: requiredString(payload.access_token, 'access token'),
        tokenType: optionalString(payload.token_type) ?? 'bearer',
        expiresIn: numberValue(payload.expires_in, 'expires_in'),
      }
    })
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      await rm(this.path(), { force: true })
    })
  }

  private generateCredential(apiBaseUrl = ''): StoredCloudCredential {
    this.requireEncryption()
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    return {
      version: 1,
      apiBaseUrl,
      publicKey: normalizePublicKey(publicKey.export({ format: 'jwk' })),
      encryptedPrivateKey: this.encrypt(
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
      ),
      encryptedRefreshToken: this.encrypt(''),
    }
  }

  private async readCredential(): Promise<StoredCloudCredential | null> {
    try {
      const value = JSON.parse(await readFile(this.path(), 'utf8')) as unknown
      return normalizeStoredCredential(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeCredential(credential: StoredCloudCredential): Promise<void> {
    const path = this.path()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private encrypt(value: string): string {
    this.requireEncryption()
    return this.encryption.encryptString(value).toString('base64')
  }

  private decrypt(value: string): string {
    this.requireEncryption()
    return this.encryption.decryptString(Buffer.from(value, 'base64'))
  }

  private requireEncryption(): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new CloudCredentialError(
        'credentials_unavailable',
        'Operating system credential encryption is unavailable'
      )
    }
  }

  private path(): string {
    return join(this.dataDirectory, 'cloud-credentials.json')
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function createDeviceProof(
  privateKey: string,
  publicKey: DevicePublicKey,
  refreshToken: string,
  endpointPath: string
): string {
  const header = base64url(
    JSON.stringify({
      alg: 'ES256',
      typ: 'dpop+jwt',
      jwk: publicKey,
    })
  )
  const payload = base64url(
    JSON.stringify({
      htm: 'POST',
      htu: endpointPath,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      ath: createHash('sha256').update(refreshToken).digest('base64url'),
    })
  )
  const signingInput = `${header}.${payload}`
  const signature = signBytes('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return `${signingInput}.${signature}`
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function normalizeApiBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const url = new URL(normalized)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new CloudCredentialError('request_failed', 'Cloud API URL is invalid')
  }
  return normalized
}

function normalizePublicKey(value: unknown): DevicePublicKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudCredentialError('credentials_unavailable', 'Device key is invalid')
  }
  const key = value as Record<string, unknown>
  if (
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string'
  ) {
    throw new CloudCredentialError('credentials_unavailable', 'Generated device key is invalid')
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: key.x,
    y: key.y,
  }
}

function normalizeStoredCredential(value: unknown): StoredCloudCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<StoredCloudCredential>
  if (
    record.version !== 1 ||
    typeof record.apiBaseUrl !== 'string' ||
    typeof record.encryptedPrivateKey !== 'string' ||
    typeof record.encryptedRefreshToken !== 'string' ||
    !record.publicKey
  ) {
    return null
  }
  return {
    version: 1,
    apiBaseUrl: record.apiBaseUrl,
    publicKey: normalizePublicKey(record.publicKey),
    encryptedPrivateKey: record.encryptedPrivateKey,
    encryptedRefreshToken: record.encryptedRefreshToken,
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function requestError(status: number, payload: Record<string, unknown>): CloudCredentialError {
  const message =
    optionalString(payload.detail) ??
    optionalString(payload.error) ??
    `Cloud credential request failed with HTTP ${status}`
  return new CloudCredentialError(
    status === 401 ? 'cloud_auth_expired' : 'request_failed',
    message,
    status
  )
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value)
  if (!result) {
    throw new CloudCredentialError('request_failed', `Authorization response is missing ${name}`)
  }
  return result
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CloudCredentialError('request_failed', `Authorization response has invalid ${name}`)
  }
  return value
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isPollStatus(value: string): value is AuthorizationPollResult['status'] {
  return ['pending', 'success', 'declined', 'failed'].includes(value)
}
