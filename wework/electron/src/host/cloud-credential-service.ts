import { createHash, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { systemSecretProtection, type SecretProtection } from './secret-protection.js'
import { protectedCredentialDirectory } from './credential-storage-paths.js'

const CLOUD_CREDENTIAL_REQUEST_TIMEOUT_MS = 30_000

interface StoredCloudCredential {
  version: 2
  apiBaseUrl: string
  publicKey: DevicePublicKey
  privateKey: string
  refreshToken: string
  ownerUserId?: number
}

export interface DevicePublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface AuthorizationPollInput {
  authorizationId: string
  sessionId: string
  pollToken: string
}

export interface PreparedCloudAuthorization {
  authorizationId: string
  publicKey: DevicePublicKey
}

interface CloudAuthorizationCandidate {
  id: string
  apiBaseUrl: string
  credential: StoredCloudCredential | null
  claimed: boolean
  refreshToken: string | null
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

export class CloudCredentialError extends Error {
  constructor(
    readonly code:
      | 'credentials_unavailable'
      | 'cloud_auth_expired'
      | 'request_failed'
      | 'request_timeout'
      | 'authorization_cancelled',
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'CloudCredentialError'
  }
}

export class CloudCredentialService {
  private operation = Promise.resolve()
  private candidate: CloudAuthorizationCandidate | null = null
  private activeRevision = 0

  constructor(
    private readonly dataDirectory: string,
    private readonly request?: typeof fetch,
    private readonly protection: SecretProtection = systemSecretProtection
  ) {}

  /**
   * Cloud credential calls must never hang.
   *
   * The service serializes its operations, so one unanswered request keeps
   * every later refresh queued behind it: the desktop connection then stays on
   * an expired access token until the workbench is reloaded.
   */
  private async requestWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
    try {
      const request = this.request ?? (await import('./cloud-http.js')).cloudFetch
      return await request(endpoint, {
        ...init,
        signal: AbortSignal.timeout(CLOUD_CREDENTIAL_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if ((error as { name?: unknown })?.name === 'TimeoutError') {
        // The host has no locale, so report a stable code the renderer can show.
        throw new CloudCredentialError('request_timeout', 'Cloud credential request timed out')
      }
      throw error
    }
  }

  prepareAuthorization(apiBaseUrl: string): Promise<PreparedCloudAuthorization> {
    const candidate: CloudAuthorizationCandidate = {
      id: randomUUID(),
      apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
      credential: null,
      claimed: false,
      refreshToken: null,
    }
    this.candidate = candidate
    return this.serial(async () => {
      const stored = await this.readCredential()
      this.requireCandidate(candidate.id)
      candidate.credential = stored ?? this.generateCredential(candidate.apiBaseUrl)
      return { authorizationId: candidate.id, publicKey: candidate.credential.publicKey }
    })
  }

  claimAuthorization(input: AuthorizationPollInput): Promise<AuthorizationPollResult> {
    return this.serial(async () => {
      const candidate = this.requireCandidate(input.authorizationId)
      const apiBaseUrl = candidate.apiBaseUrl
      const endpoint = `${apiBaseUrl}/auth/wework/sessions/${encodeURIComponent(
        input.sessionId
      )}/poll?poll_token=${encodeURIComponent(input.pollToken)}`
      const response = await this.requestWithTimeout(endpoint, { method: 'GET' })
      const payload = await responseJson(response)
      this.requireCandidate(input.authorizationId)
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
      const refreshToken = optionalString(payload.refresh_token)
      candidate.claimed = true
      candidate.refreshToken = refreshToken ?? null
      return {
        status,
        accessToken,
        tokenType: optionalString(payload.token_type),
        username: optionalString(payload.username),
        credentialMode: refreshToken ? 'desktop_refresh' : 'legacy_access_token',
      }
    })
  }

  commitAuthorization(authorizationId: string, ownerUserId: number): Promise<void> {
    requireUserId(ownerUserId)
    return this.serial(async () => {
      const candidate = this.requireCandidate(authorizationId)
      if (!candidate.claimed || !candidate.credential) {
        throw new CloudCredentialError('request_failed', 'Cloud authorization is not verified')
      }
      if (candidate.refreshToken) {
        await this.writeCredential(
          {
            ...candidate.credential,
            apiBaseUrl: candidate.apiBaseUrl,
            refreshToken: candidate.refreshToken,
            ownerUserId,
          },
          () => {
            this.requireCandidate(candidate.id)
            // Issuing the atomic rename is the commit point. A later prepare
            // belongs to the next transaction and cannot revoke this owner.
            this.candidate = null
            this.activeRevision += 1
          }
        )
      } else {
        this.candidate = null
        this.activeRevision += 1
        await this.removeCredential()
      }
    })
  }

  discardAuthorization(authorizationId: string): Promise<void> {
    if (this.candidate?.id === authorizationId) this.candidate = null
    return Promise.resolve()
  }

  refreshAccessToken(apiBaseUrl: string, expectedUserId: number): Promise<RefreshedAccessToken> {
    requireUserId(expectedUserId)
    const revision = this.activeRevision
    return this.serial(async () => {
      this.requireActiveRevision(revision)
      const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl)
      const credential = await this.readCredential()
      this.requireActiveRevision(revision)
      if (!credential || credential.apiBaseUrl !== normalizedApiBaseUrl) {
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Desktop cloud credentials are unavailable'
        )
      }
      if (credential.ownerUserId !== undefined && credential.ownerUserId !== expectedUserId) {
        throw new CloudCredentialError('cloud_auth_expired', 'Cloud credential owner changed')
      }
      const refreshToken = credential.refreshToken
      if (!refreshToken) {
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Desktop cloud credentials are incomplete'
        )
      }
      const endpoint = `${normalizedApiBaseUrl}/auth/wework/refresh`
      const proof = createDeviceProof(
        credential.privateKey,
        credential.publicKey,
        refreshToken,
        new URL(endpoint).pathname
      )
      const response = await this.requestWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: refreshToken,
          proof,
        }),
      })
      const payload = await responseJson(response)
      this.requireActiveRevision(revision)
      if (!response.ok) {
        throw requestError(response.status, payload)
      }
      const accessToken = requiredString(payload.access_token, 'access token')
      if (credential.ownerUserId === undefined) {
        await this.bindCredentialOwner(credential, accessToken, expectedUserId, revision)
      }
      this.requireActiveRevision(revision)
      return {
        accessToken,
        tokenType: optionalString(payload.token_type) ?? 'bearer',
        expiresIn: numberValue(payload.expires_in, 'expires_in'),
      }
    })
  }

  clear(): Promise<void> {
    this.candidate = null
    this.activeRevision += 1
    return this.serial(async () => {
      await this.removeCredential()
    })
  }

  /** Native-only result: pass directly to Executor, never to a renderer. */
  pluginNativeSession(
    apiBaseUrl: string,
    accountToken: string
  ): Promise<{
    backend_url: string
    account_token: string
    native_token: string
    expires_at: number
  } | null> {
    const revision = this.activeRevision
    return this.serial(async () => {
      const base = normalizeApiBaseUrl(apiBaseUrl)
      const credential = await this.readCredential()
      this.requireActiveRevision(revision)
      if (!credential || credential.apiBaseUrl !== base || !credential.ownerUserId)
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Desktop plugin credentials unavailable'
        )
      const ownerResponse = await this.requestWithTimeout(`${base}/users/me`, {
        headers: { Authorization: `Bearer ${accountToken}` },
      })
      const owner = await responseJson(ownerResponse)
      if (!ownerResponse.ok || owner.id !== credential.ownerUserId)
        throw new CloudCredentialError('cloud_auth_expired', 'Plugin account owner changed')
      const endpoint = `${base}/plugins/native-auth/exchange`
      const response = await this.requestWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'session',
          data: {
            refresh_token: credential.refreshToken,
            proof: createDeviceProof(
              credential.privateKey,
              credential.publicKey,
              credential.refreshToken,
              '/api/plugins/native-auth/exchange'
            ),
          },
        }),
      })
      this.requireActiveRevision(revision)
      if (response.status === 404) return null
      const result = await responseJson(response)
      if (!response.ok) throw requestError(response.status, result)
      if (result.protocolVersion !== 1 || result.account_id !== credential.ownerUserId)
        throw new CloudCredentialError('request_failed', 'Invalid plugin authorization response')
      const expiresAt = numberValue(result.expires_at, 'plugin session expiry')
      if (expiresAt <= Math.floor(Date.now() / 1000))
        throw new CloudCredentialError('cloud_auth_expired', 'Plugin authorization expired')
      return {
        backend_url: base.replace(/\/api$/, ''),
        account_token: accountToken,
        native_token: requiredString(result.native_token, 'native plugin token'),
        expires_at: expiresAt,
      }
    })
  }

  private generateCredential(apiBaseUrl = ''): StoredCloudCredential {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    return {
      version: 2,
      apiBaseUrl,
      publicKey: normalizePublicKey(publicKey.export({ format: 'jwk' })),
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      refreshToken: '',
    }
  }

  private async readCredential(): Promise<StoredCloudCredential | null> {
    try {
      let envelope = await this.readEnvelope()
      const importing = envelope === null
      if (importing) {
        envelope = await this.readEnvelope(join(this.dataDirectory, 'cloud-credentials.json'))
      } else if (envelope?.version !== 3) {
        throw new CloudCredentialError('credentials_unavailable', 'Invalid protected storage')
      }
      if (!envelope) {
        await this.writeCredential(null, () => {})
        return null
      }
      const decrypted =
        envelope.version === 3 && envelope.ciphertext !== null
          ? await this.protection.decrypt(envelope.ciphertext ?? '')
          : null
      const value =
        envelope.version === 3 ? (decrypted ? JSON.parse(decrypted.result) : null) : envelope
      const credential = normalizeStoredCredential(value)
      if (value !== null && !credential) {
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Cloud credential format is invalid'
        )
      }
      if (importing || decrypted?.shouldReEncrypt) {
        await this.writeCredential(credential, () => {})
      }
      return credential
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeCredential(
    credential: StoredCloudCredential | null,
    beforeRename: () => void
  ): Promise<void> {
    const path = this.path()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    try {
      const ciphertext =
        credential === null ? null : await this.protection.encrypt(JSON.stringify(credential))
      await writeFile(temporary, `${JSON.stringify({ version: 3, ciphertext })}\n`, { mode: 0o600 })
      beforeRename()
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async readEnvelope(
    path = this.path()
  ): Promise<{ version?: number; ciphertext?: string | null } | null> {
    try {
      const envelope = JSON.parse(await readFile(path, 'utf8'))
      if (
        !envelope ||
        ![2, 3].includes(envelope.version) ||
        (envelope.version === 3 &&
          envelope.ciphertext !== null &&
          typeof envelope.ciphertext !== 'string')
      ) {
        throw new CloudCredentialError(
          'credentials_unavailable',
          'Cloud credential format is invalid'
        )
      }
      return envelope
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async removeCredential(): Promise<void> {
    // A tombstone prevents a later launch from importing a signed-out legacy credential.
    await this.writeCredential(null, () => {})
  }

  private async bindCredentialOwner(
    credential: StoredCloudCredential,
    accessToken: string,
    expectedUserId: number,
    revision: number
  ): Promise<void> {
    const response = await this.requestWithTimeout(`${credential.apiBaseUrl}/users/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const user = await responseJson(response)
    this.requireActiveRevision(revision)
    if (!response.ok) throw requestError(response.status, user)
    if (user.id !== expectedUserId) {
      throw new CloudCredentialError('cloud_auth_expired', 'Cloud credential owner changed')
    }
    await this.writeCredential({ ...credential, ownerUserId: expectedUserId }, () =>
      this.requireActiveRevision(revision)
    )
  }

  private requireCandidate(authorizationId: string): CloudAuthorizationCandidate {
    if (this.candidate?.id !== authorizationId) {
      throw new CloudCredentialError('authorization_cancelled', 'Cloud authorization was cancelled')
    }
    return this.candidate
  }

  private requireActiveRevision(revision: number): void {
    if (revision !== this.activeRevision) {
      throw new CloudCredentialError('authorization_cancelled', 'Cloud credentials changed')
    }
  }

  private path(): string {
    return join(protectedCredentialDirectory(this.dataDirectory), 'cloud-credentials.json')
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
    record.version !== 2 ||
    typeof record.apiBaseUrl !== 'string' ||
    typeof record.privateKey !== 'string' ||
    typeof record.refreshToken !== 'string' ||
    !record.publicKey
  ) {
    return null
  }
  if (record.ownerUserId !== undefined) requireUserId(record.ownerUserId)
  return {
    version: 2,
    apiBaseUrl: record.apiBaseUrl,
    publicKey: normalizePublicKey(record.publicKey),
    privateKey: record.privateKey,
    refreshToken: record.refreshToken,
    ...(record.ownerUserId === undefined ? {} : { ownerUserId: record.ownerUserId }),
  }
}

function requireUserId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new CloudCredentialError('request_failed', 'Cloud credential owner is invalid')
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
