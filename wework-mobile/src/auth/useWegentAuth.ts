import * as WebBrowser from 'expo-web-browser'
import { AppState } from 'react-native'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createAuthorizationSession,
  fetchCurrentUser,
  jwtExpiry,
  type WegentUser,
} from './authClient'
import { DeviceCredentialService } from './deviceCredentials'
import {
  checkBackendHealth,
  configuredBackendUrl,
  resolveBackendConfig,
  type BackendConfig,
  type RuntimeSessionConfig,
} from '@/services/backendConfig'
import { loadBackendAddress, saveBackendAddress } from '@/services/backendAddressStore'

export type AuthStatus =
  'initializing' | 'unauthenticated' | 'authorizing' | 'authenticated' | 'error'

export interface WegentAuthState {
  status: AuthStatus
  config: RuntimeSessionConfig | null
  backend: BackendConfig | null
  backendUrl: string
  user: WegentUser | null
  error: string | null
  setBackendUrl: (value: string) => void
  login: () => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<boolean>
}

const ACCESS_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000
const MIN_REFRESH_DELAY_MS = 1000
const credentials = new DeviceCredentialService()

export function useWegentAuth(): WegentAuthState {
  const [backendInput, setBackendInput] = useState('')
  const [status, setStatus] = useState<AuthStatus>('initializing')
  const [backend, setBackend] = useState<BackendConfig | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [accessTokenExpiresAt, setAccessTokenExpiresAt] = useState<number | null>(null)
  const [user, setUser] = useState<WegentUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loginPromise = useRef<Promise<void> | null>(null)
  const activeGeneration = useRef(0)

  const applyToken = useCallback(
    async (config: BackendConfig, token: string, explicitExpiry?: number): Promise<void> => {
      const currentUser = await fetchCurrentUser(config, token)
      setBackend(config)
      setAccessToken(token)
      setAccessTokenExpiresAt(explicitExpiry ?? jwtExpiry(token))
      setUser(currentUser)
      setError(null)
      setStatus('authenticated')
    },
    []
  )

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!backend) return false
    const generation = activeGeneration.current
    try {
      const result = await credentials.refreshAccessToken(backend.apiBaseUrl)
      if (activeGeneration.current !== generation) return false
      await applyToken(
        backend,
        result.accessToken,
        result.expiresIn > 0 ? Date.now() + result.expiresIn * 1000 : undefined
      )
      return true
    } catch (cause) {
      if (activeGeneration.current !== generation) return false
      setAccessToken(null)
      setAccessTokenExpiresAt(null)
      setUser(null)
      setStatus('unauthenticated')
      setError(messageFrom(cause))
      return false
    }
  }, [applyToken, backend])

  useEffect(() => {
    const generation = activeGeneration.current
    void (async () => {
      try {
        const backendUrl = (await loadBackendAddress()) ?? configuredBackendUrl()
        if (activeGeneration.current !== generation) return
        setBackendInput(backendUrl ?? '')
        if (!backendUrl) {
          setStatus('unauthenticated')
          return
        }
        const config = await resolveBackendConfig(backendUrl)
        await checkBackendHealth(config)
        if (activeGeneration.current !== generation) return
        setBackend(config)
        if (!(await credentials.hasRefreshCredential(config.apiBaseUrl))) {
          setStatus('unauthenticated')
          return
        }
        const result = await credentials.refreshAccessToken(config.apiBaseUrl)
        if (activeGeneration.current !== generation) return
        await applyToken(
          config,
          result.accessToken,
          result.expiresIn > 0 ? Date.now() + result.expiresIn * 1000 : undefined
        )
      } catch (cause) {
        if (activeGeneration.current !== generation) return
        setStatus('error')
        setError(messageFrom(cause))
      }
    })()
  }, [applyToken])

  const setBackendUrl = useCallback((value: string): void => {
    activeGeneration.current += 1
    setBackendInput(value)
    setBackend(null)
    setError(null)
    setStatus('unauthenticated')
  }, [])

  const login = useCallback((): Promise<void> => {
    if (loginPromise.current) return loginPromise.current
    const generation = activeGeneration.current + 1
    activeGeneration.current = generation
    const operation = (async () => {
      setStatus('authorizing')
      setError(null)
      const requestedBackend = backendInput.trim()
      if (!requestedBackend) throw new Error('请输入 Backend 地址')
      const config = await resolveBackendConfig(requestedBackend)
      await checkBackendHealth(config)
      if (activeGeneration.current !== generation) return
      await saveBackendAddress(config.backendUrl)
      setBackendInput(config.backendUrl)
      setBackend(config)
      const publicKey = await credentials.publicKey()
      const session = await createAuthorizationSession(config, publicKey)
      void WebBrowser.openBrowserAsync(session.authorize_url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FORM_SHEET,
        controlsColor: '#181818',
      }).catch(() => undefined)

      const pollDelay = Math.max(500, session.poll_interval_seconds * 1000 || 2000)
      while (Date.now() < session.expires_at * 1000) {
        await delay(pollDelay)
        if (activeGeneration.current !== generation) return
        const result = await credentials.claimAuthorization({
          apiBaseUrl: config.apiBaseUrl,
          sessionId: session.session_id,
          pollToken: session.poll_token,
        })
        if (result.status === 'pending') continue
        if (result.status === 'declined') throw new Error('授权已取消')
        if (result.status === 'failed') throw new Error(result.error || '授权失败')
        if (!result.accessToken) throw new Error('授权没有返回 access token')
        WebBrowser.dismissBrowser()
        await applyToken(config, result.accessToken)
        return
      }
      throw new Error('授权已超时，请重新登录')
    })()
      .catch(cause => {
        if (activeGeneration.current !== generation) return
        setStatus('error')
        setError(messageFrom(cause))
        throw cause
      })
      .finally(() => {
        loginPromise.current = null
      })
    loginPromise.current = operation
    return operation
  }, [applyToken, backendInput])

  const logout = useCallback(async (): Promise<void> => {
    activeGeneration.current += 1
    WebBrowser.dismissBrowser()
    await credentials.clear()
    setAccessToken(null)
    setAccessTokenExpiresAt(null)
    setUser(null)
    setError(null)
    setStatus('unauthenticated')
  }, [])

  useEffect(() => {
    if (status !== 'authenticated' || !accessTokenExpiresAt) return
    const delayMs = Math.max(
      MIN_REFRESH_DELAY_MS,
      accessTokenExpiresAt - Date.now() - ACCESS_TOKEN_REFRESH_LEAD_MS
    )
    const timer = setTimeout(() => void refresh(), delayMs)
    return () => clearTimeout(timer)
  }, [accessTokenExpiresAt, refresh, status])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (
        nextState === 'active' &&
        status === 'authenticated' &&
        accessTokenExpiresAt !== null &&
        accessTokenExpiresAt - Date.now() <= ACCESS_TOKEN_REFRESH_LEAD_MS
      ) {
        void refresh()
      }
    })
    return () => subscription.remove()
  }, [accessTokenExpiresAt, refresh, status])

  return {
    status,
    backend,
    backendUrl: backendInput,
    config: backend && accessToken ? { ...backend, accessToken } : null,
    user,
    error,
    setBackendUrl,
    login,
    logout,
    refresh,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
