import { p256 } from '@noble/curves/nist.js'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'

import {
  createDeviceProof,
  decodeBase64Url,
  encodeBase64Url,
  publicKeyFromPrivate,
  type DevicePublicKey,
} from './deviceProof'
import { errorMessage, responseJson } from '@/services/backendConfig'

export type { DevicePublicKey } from './deviceProof'

interface StoredDeviceCredential {
  version: 2
  apiBaseUrl: string
  privateKey: string
  publicKey: DevicePublicKey
  refreshToken: string
}

interface PollResponse {
  status: 'pending' | 'success' | 'declined' | 'failed'
  access_token?: string
  refresh_token?: string
  token_type?: string
  username?: string
  error?: string
}

interface RefreshResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
}

const CREDENTIAL_KEY = 'wegent.mobile.cloud-credentials.v2'

export class DeviceCredentialService {
  private serial: Promise<unknown> = Promise.resolve()

  async publicKey(): Promise<DevicePublicKey> {
    return this.enqueue(async () => {
      const existing = await this.readStored()
      if (existing) return existing.publicKey
      const created = createCredential()
      await this.writeStored(created)
      return created.publicKey
    })
  }

  async claimAuthorization(input: {
    apiBaseUrl: string
    sessionId: string
    pollToken: string
  }): Promise<{
    status: PollResponse['status']
    accessToken?: string
    refreshToken?: string
    username?: string
    error?: string
  }> {
    const endpoint = `${input.apiBaseUrl}/auth/wework/sessions/${encodeURIComponent(
      input.sessionId
    )}/poll?poll_token=${encodeURIComponent(input.pollToken)}`
    const response = await fetch(endpoint)
    const body = await responseJson<PollResponse>(response)
    if (!response.ok) throw new Error(errorMessage(body, response.status))
    if (body.status !== 'success') {
      return { status: body.status, error: body.error }
    }
    if (!body.access_token) throw new Error('授权响应缺少 access token')
    if (!body.refresh_token) throw new Error('授权响应缺少设备绑定 refresh token')
    return {
      status: 'success',
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      username: body.username,
    }
  }

  persistRefreshToken(
    apiBaseUrl: string,
    refreshToken: string,
    isStillValid: () => boolean
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!isStillValid()) return
      const current = (await this.readStored()) ?? createCredential()
      if (!isStillValid()) return
      const persisted: StoredDeviceCredential = {
        ...current,
        apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
        refreshToken,
      }
      await this.writeStored(persisted)
      if (isStillValid()) return
      await this.removeWrittenCredential(persisted)
    })
  }

  async refreshAccessToken(apiBaseUrl: string): Promise<{
    accessToken: string
    expiresIn: number
  }> {
    const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl)
    const credential = await this.read()
    if (!credential || credential.apiBaseUrl !== normalizedApiBaseUrl || !credential.refreshToken) {
      throw new Error('移动端登录凭据不可用')
    }
    const endpoint = `${normalizedApiBaseUrl}/auth/wework/refresh`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: credential.refreshToken,
        proof: createDeviceProof(
          decodeBase64Url(credential.privateKey),
          credential.publicKey,
          credential.refreshToken,
          new URL(endpoint).pathname,
          Date.now(),
          Crypto.randomUUID()
        ),
      }),
    })
    const body = await responseJson<RefreshResponse>(response)
    if (!response.ok) throw new Error(errorMessage(body, response.status))
    if (!body.access_token) throw new Error('刷新响应缺少 access token')
    return {
      accessToken: body.access_token,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 0,
    }
  }

  async hasRefreshCredential(apiBaseUrl: string): Promise<boolean> {
    const credential = await this.read()
    return Boolean(
      credential?.refreshToken && credential.apiBaseUrl === normalizeApiBaseUrl(apiBaseUrl)
    )
  }

  clear(): Promise<void> {
    return this.enqueue(() => SecureStore.deleteItemAsync(CREDENTIAL_KEY))
  }

  private read(): Promise<StoredDeviceCredential | null> {
    return this.enqueue(() => this.readStored())
  }

  // Runs inside the serial queue, so no queued credential operation can
  // interleave between this operation's write and this check; the identity
  // comparison still guards against deleting a record this operation did not
  // write.
  private async removeWrittenCredential(written: StoredDeviceCredential): Promise<void> {
    const current = await this.readStored()
    if (
      !current ||
      current.privateKey !== written.privateKey ||
      current.apiBaseUrl !== written.apiBaseUrl ||
      current.refreshToken !== written.refreshToken
    ) {
      return
    }
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial
    let release!: () => void
    this.serial = new Promise<void>(resolve => {
      release = resolve
    })
    return previous.then(operation, operation).finally(release)
  }

  private async readStored(): Promise<StoredDeviceCredential | null> {
    const raw = await SecureStore.getItemAsync(CREDENTIAL_KEY)
    if (!raw) return null
    try {
      return normalizeCredential(JSON.parse(raw))
    } catch {
      await SecureStore.deleteItemAsync(CREDENTIAL_KEY)
      return null
    }
  }

  private writeStored(credential: StoredDeviceCredential): Promise<void> {
    return SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(credential), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  }
}

function createCredential(): StoredDeviceCredential {
  const privateKey = p256.utils.randomSecretKey(Crypto.getRandomBytes(48))
  return {
    version: 2,
    apiBaseUrl: '',
    privateKey: encodeBase64Url(privateKey),
    publicKey: publicKeyFromPrivate(privateKey),
    refreshToken: '',
  }
}

function normalizeCredential(value: unknown): StoredDeviceCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<StoredDeviceCredential>
  if (
    record.version !== 2 ||
    typeof record.apiBaseUrl !== 'string' ||
    typeof record.privateKey !== 'string' ||
    typeof record.refreshToken !== 'string' ||
    !record.publicKey ||
    record.publicKey.kty !== 'EC' ||
    record.publicKey.crv !== 'P-256'
  ) {
    return null
  }
  const privateKey = decodeBase64Url(record.privateKey)
  if (!p256.utils.isValidSecretKey(privateKey)) return null
  return record as StoredDeviceCredential
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value.trim().replace(/\/+$/, ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Backend API 地址无效')
  return url.toString().replace(/\/+$/, '')
}
