import type { TFunction } from 'i18next'
import { ApiError } from '@/api/http'
import {
  commitDesktopCloudAuthorization,
  clearDesktopCloudCredentials,
  discardDesktopCloudAuthorization,
  DesktopCloudCredentialError,
  prepareDesktopCloudAuthorization,
} from '@/desktop/cloudCredentials'
import { getAppPreferences, updateAppPreferences } from '@/desktop/appPreferences'
import { subscribeSystemResume } from '@/desktop/systemResume'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import type { User } from '@/types/api'
import {
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
  type OpenCloudAuthorizationUrl,
} from './CloudConnectionContext'
import { track } from '@/telemetry/client'
import {
  checkCloudHealth,
  createWeworkAuthSession,
  fetchCloudConfig,
  fetchCloudUser,
  pollWeworkAuthSession,
} from './cloudConnectionRequests'
import {
  clearStoredCloudConnection,
  getJwtExpiry,
  normalizeStoredCloudConnection,
  readStoredCloudConnection,
  saveStoredCloudConnection,
  type CloudConnectionSnapshot,
} from './cloudConnectionStorage'
import {
  DEFAULT_AUTH_POLL_INTERVAL_MS,
  CLOUD_STARTUP_REQUEST_TIMEOUT_MS,
  ACCESS_TOKEN_REFRESH_LEAD_MS,
  ACCESS_TOKEN_REFRESH_RETRY_MS,
  MAX_TIMER_DELAY_MS,
  resolveAccessToken,
  resolveCloudRuntimeConfig,
  delay,
  authWindowClosedPromise,
  snapshotFromConnection,
  snapshotFromStored,
  connectionSnapshot,
  persistSnapshot,
  getCloudErrorMessage,
} from './cloudConnectionSessionHelpers'

interface CloudAuthorizationState {
  generation: number
}

/** Staged authorization, committed ownership and token maintenance share one connection session. */
export function createCloudConnectionSession(initialTranslate: TFunction) {
  let t = initialTranslate
  let snapshot = snapshotFromStored(false)
  let authorization: CloudAuthorizationState | null = null
  let desktopRestoreSettled = false
  let e2eSessionRevision = 0
  let initialRefreshStarted = false
  let desktopRestoreStarted = false
  let inFlightRefresh: Promise<User | null> | null = null
  let refreshAttemptSequence = 0
  let ownerGeneration = 0
  let candidateGeneration = 0
  let disconnectEpoch = 0
  const credentialCommits = new Set<symbol>()
  let commitSequence = 0
  let publishedCommit = 0
  let disconnectRequested = false
  let terminalCredentialExpiry = false
  const listeners = new Set<() => void>()
  let value: CloudConnectionContextValue
  let batching = false
  let dirty = false
  let lifetime = 0
  let observing = false
  let rendererRestored = false
  let stopResume: (() => void) | undefined
  let stopExpiry: (() => void) | undefined
  let stopRetry: (() => void) | undefined
  let configDependencies: unknown[] | undefined
  let expiryDependencies: unknown[] | undefined
  let retryDependencies: unknown[] | undefined
  const same = (previous: unknown[] | undefined, next: unknown[]) =>
    previous?.length === next.length && previous.every((item, index) => item === next[index])
  const publish = () => {
    if (batching) {
      dirty = true
      return
    }
    if (updateValue()) listeners.forEach(listener => listener())
    reconcile()
  }
  const batch = (action: () => void) => {
    batching = true
    try {
      action()
    } finally {
      batching = false
      if (dirty) {
        dirty = false
        publish()
      }
    }
  }
  const setSnapshot = (
    update:
      | CloudConnectionSnapshot
      | ((current: CloudConnectionSnapshot) => CloudConnectionSnapshot)
  ) => {
    const next = typeof update === 'function' ? update(snapshot) : update
    if (next === snapshot) return
    snapshot = next
    publish()
  }
  const setAuthorization = (
    update:
      | CloudAuthorizationState
      | null
      | ((current: CloudAuthorizationState | null) => CloudAuthorizationState | null)
  ) => {
    const next = typeof update === 'function' ? update(authorization) : update
    if (next === authorization) return
    authorization = next
    publish()
  }
  const setDesktopRestoreSettled = (settled: boolean) => {
    desktopRestoreSettled = settled
    publish()
  }
  const applyConnectedSnapshot = (
    nextSnapshot: CloudConnectionSnapshot,
    commitRevision: number,
    disconnectRevision: number
  ) => {
    setSnapshot(current => {
      if (disconnectEpoch !== disconnectRevision || publishedCommit !== commitRevision) {
        return current
      }
      persistSnapshot(nextSnapshot)
      return nextSnapshot
    })
  }
  const connectWithAuthorization = async (
    backendUrl: string,
    openAuthorizationUrl?: OpenCloudAuthorizationUrl,
    socketBaseUrlOverride?: string
  ): Promise<User> => {
    disconnectRequested = false
    terminalCredentialExpiry = false
    const authorizationGeneration = candidateGeneration + 1
    candidateGeneration = authorizationGeneration
    const disconnectRevision = disconnectEpoch
    let authorizationId: string | null = null
    let config = resolveCloudRuntimeConfig(backendUrl, socketBaseUrlOverride)
    // Keep candidate endpoints request-local until their authenticated user is
    // ready, so consumers never observe a new backend with the previous owner.
    setAuthorization({
      generation: authorizationGeneration,
    })

    try {
      const prepared = await prepareDesktopCloudAuthorization(config.apiBaseUrl)
      authorizationId = prepared.authorizationId
      if (candidateGeneration !== authorizationGeneration) {
        throw new Error('Cloud connection was cancelled')
      }
      await checkCloudHealth(config)
      const metadata = await fetchCloudConfig(config)
      if (candidateGeneration !== authorizationGeneration) {
        throw new Error('Cloud connection was cancelled')
      }
      config = resolveCloudRuntimeConfig(backendUrl, socketBaseUrlOverride, metadata.socketUrl)
      const session = await createWeworkAuthSession(config, prepared.publicKey)
      if (candidateGeneration !== authorizationGeneration) {
        throw new Error('Cloud connection was cancelled')
      }
      const authorizationHandle = await openAuthorizationUrl?.(session.authorize_url)
      const windowClosed = authWindowClosedPromise(authorizationHandle)

      const pollIntervalMs =
        Number.isFinite(session.poll_interval_seconds) && session.poll_interval_seconds > 0
          ? session.poll_interval_seconds * 1000
          : DEFAULT_AUTH_POLL_INTERVAL_MS
      const expiresAtMs = session.expires_at * 1000

      while (Date.now() < expiresAtMs) {
        if (candidateGeneration !== authorizationGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        if (windowClosed) {
          await Promise.race([delay(pollIntervalMs), windowClosed])
        } else {
          await delay(pollIntervalMs)
        }
        const pollResult = windowClosed
          ? await Promise.race([
              pollWeworkAuthSession(config, session, authorizationId),
              windowClosed,
            ])
          : await pollWeworkAuthSession(config, session, authorizationId)
        if (candidateGeneration !== authorizationGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        if (pollResult.status === 'pending') continue
        if (pollResult.status === 'declined') {
          throw new Error('云端授权已取消')
        }
        if (pollResult.status === 'failed') {
          throw new Error(pollResult.error || '云端授权失败')
        }
        if (!pollResult.accessToken) {
          throw new Error('云端授权未返回登录凭证')
        }
        await Promise.resolve(authorizationHandle?.close?.()).catch(error => {
          console.warn('[CloudConnection] Failed to close authorization window', error)
        })
        const user = await fetchCloudUser(config, pollResult.accessToken)
        if (candidateGeneration !== authorizationGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        const commit = Symbol('cloud-credential-commit')
        const commitRevision = ++commitSequence
        credentialCommits.add(commit)
        ownerGeneration += 1
        refreshAttemptSequence += 1
        inFlightRefresh = null
        try {
          await commitDesktopCloudAuthorization(authorizationId, user.id)
          if (disconnectEpoch !== disconnectRevision) {
            throw new Error('Cloud connection was cancelled')
          }
          // Native commit has linearized. A newer pending candidate cannot
          // revoke this active owner; a later successful commit replaces it.
          if (commitRevision > publishedCommit) {
            publishedCommit = commitRevision
            ownerGeneration += 1
            initialRefreshStarted = true
            applyConnectedSnapshot(
              connectionSnapshot(
                config,
                session.web_url,
                pollResult.accessToken,
                user,
                pollResult.credentialMode ?? 'desktop_refresh',
                socketBaseUrlOverride
              ),
              commitRevision,
              disconnectRevision
            )
          }
        } finally {
          credentialCommits.delete(commit)
        }
        setAuthorization(current =>
          current?.generation === authorizationGeneration ? null : current
        )
        track('cloud_connection_changed', { connected: true })
        return user
      }

      throw new Error('云端授权已超时，请重新连接')
    } catch (error) {
      track('operation_failed', { operation: 'cloud_connect' })
      setAuthorization(current =>
        current?.generation === authorizationGeneration ? null : current
      )
      setSnapshot(current =>
        disconnectRequested ||
        candidateGeneration !== authorizationGeneration ||
        (current.status === 'connected' && current.token)
          ? current
          : { ...current, status: 'error', token: null, error: getCloudErrorMessage(error, t) }
      )
      throw error
    } finally {
      if (authorizationId) {
        await discardDesktopCloudAuthorization(authorizationId).catch(error => {
          console.warn('[CloudConnection] Failed to discard cloud authorization', error)
        })
      }
    }
  }
  const refreshUser = (): Promise<User | null> => {
    const requestSnapshot = snapshot
    if (disconnectRequested) return Promise.resolve(null)
    if (credentialCommits.size > 0) return Promise.resolve(null)
    if (inFlightRefresh) return inFlightRefresh
    if (!requestSnapshot.apiBaseUrl || !requestSnapshot.user) return Promise.resolve(null)
    const refreshGeneration = ownerGeneration
    const refreshAttemptId = refreshAttemptSequence + 1
    refreshAttemptSequence = refreshAttemptId
    const credentialMode = requestSnapshot.credentialMode ?? 'desktop_refresh'
    const config = {
      backendUrl: requestSnapshot.backendUrl ?? '',
      apiBaseUrl: requestSnapshot.apiBaseUrl,
      socketBaseUrl: requestSnapshot.socketBaseUrl ?? requestSnapshot.backendUrl ?? '',
      socketPath: requestSnapshot.socketPath ?? '/socket.io',
    }
    const refresh = (async () => {
      try {
        // Awaiting a resolved-token helper keeps the first suspension inside the
        // try block, so the guard below is always assigned before it is cleared.
        const accessToken = await resolveAccessToken(
          config.apiBaseUrl,
          credentialMode,
          requestSnapshot.token,
          requestSnapshot.user!.id
        )
        if (!accessToken) {
          throw new DesktopCloudCredentialError(
            'credentials_unavailable',
            'Cloud access token is unavailable',
            null
          )
        }
        if (ownerGeneration !== refreshGeneration) return null
        const user = await fetchCloudUser(config, accessToken, CLOUD_STARTUP_REQUEST_TIMEOUT_MS)
        if (ownerGeneration !== refreshGeneration) return null
        terminalCredentialExpiry = false
        setSnapshot(current => {
          if (disconnectRequested || ownerGeneration !== refreshGeneration) {
            return current
          }
          const nextSnapshot = {
            ...current,
            status: 'connected' as const,
            credentialMode,
            token: accessToken,
            tokenExpiresAt: getJwtExpiry(accessToken),
            user,
            error: null,
          }
          persistSnapshot(nextSnapshot)
          return nextSnapshot
        })
        return user
      } catch (error) {
        if (ownerGeneration !== refreshGeneration) return null
        const authExpired =
          (error instanceof ApiError && error.status === 401) ||
          (error instanceof DesktopCloudCredentialError && error.code === 'cloud_auth_expired')
        if (authExpired && credentialMode === 'desktop_refresh') {
          terminalCredentialExpiry = true
        }
        setSnapshot(current =>
          authExpired
            ? {
                ...current,
                status: 'expired',
                token: null,
                tokenExpiresAt:
                  credentialMode === 'legacy_access_token' ? current.tokenExpiresAt : null,
                error: 'Cloud login has expired',
              }
            : {
                ...current,
                status: current.status === 'connected' && current.token ? 'connected' : 'error',
                error: getCloudErrorMessage(error, t),
              }
        )
        return null
      } finally {
        // Release the in-flight guard whenever this attempt settles, whatever
        // happened to it (timeout, failure, superseded generation). Keeping the
        // guard would silently disable every later automatic refresh, and a
        // newer attempt already owns it when it exists.
        if (refreshAttemptSequence === refreshAttemptId) {
          inFlightRefresh = null
        }
      }
    })()
    inFlightRefresh = refresh
    return refresh
  }
  const refreshAutomatically = () => {
    if (terminalCredentialExpiry) return
    void refreshUser()
  }
  const disconnect = () =>
    batch(() => {
      disconnectRequested = true
      terminalCredentialExpiry = false
      ownerGeneration += 1
      candidateGeneration += 1
      disconnectEpoch += 1
      inFlightRefresh = null
      clearStoredCloudConnection()
      setAuthorization(null)
      setSnapshot(DISCONNECTED_STATE)
      void updateAppPreferences({ cloudConnection: null }).catch(error => {
        console.error('[CloudConnection] Failed to clear desktop cloud connection', error)
      })
      void (async () => clearDesktopCloudCredentials())().catch(error => {
        console.error('[CloudConnection] Failed to clear desktop cloud credentials', error)
      })
      track('cloud_connection_changed', { connected: false })
    })
  const restoreDesktop = () => {
    if (desktopRestoreStarted) return
    desktopRestoreStarted = true
    const restoreLifetime = lifetime
    const restoreGeneration = ownerGeneration
    const restoreAuthorizationGeneration = candidateGeneration
    void Promise.resolve()
      .then(() => getAppPreferences())
      .then(preferences => {
        if (
          restoreLifetime !== lifetime ||
          disconnectRequested ||
          ownerGeneration !== restoreGeneration ||
          candidateGeneration !== restoreAuthorizationGeneration
        ) {
          return
        }
        const stored = normalizeStoredCloudConnection(preferences.cloudConnection)
        if (!stored) return
        setSnapshot(current => {
          if (
            disconnectRequested ||
            ownerGeneration !== restoreGeneration ||
            candidateGeneration !== restoreAuthorizationGeneration
          ) {
            return current
          }
          saveStoredCloudConnection(stored)
          return snapshotFromConnection(stored)
        })
      })
      .catch(error => {
        console.error('[CloudConnection] Failed to restore desktop cloud connection', error)
      })
      .finally(() => {
        if (restoreLifetime === lifetime) setDesktopRestoreSettled(true)
      })
  }
  const resolveConfiguration = () => {
    const requestSnapshot = snapshot

    if (
      !desktopRestoreSettled ||
      requestSnapshot.status !== 'connected' ||
      !requestSnapshot.backendUrl
    )
      return
    const configGeneration = ownerGeneration
    const backendUrl = requestSnapshot.backendUrl
    const config = resolveCloudRuntimeConfig(backendUrl, requestSnapshot.socketBaseUrlOverride)
    void fetchCloudConfig(config, CLOUD_STARTUP_REQUEST_TIMEOUT_MS)
      .then(metadata => {
        const resolvedConfig = resolveCloudRuntimeConfig(
          backendUrl,
          requestSnapshot.socketBaseUrlOverride,
          metadata.socketUrl
        )
        setSnapshot(current => {
          if (disconnectRequested || ownerGeneration !== configGeneration) {
            return current
          }
          const nextSnapshot = {
            ...current,
            ...resolvedConfig,
            webUrl: metadata.webUrl,
          }
          persistSnapshot(nextSnapshot)
          return nextSnapshot
        })
      })
      .catch(error => {
        console.error('[CloudConnection] Failed to resolve cloud configuration', error)
      })
  }
  const initialRefresh = () => {
    if (
      !desktopRestoreSettled ||
      initialRefreshStarted ||
      !snapshot.apiBaseUrl ||
      (snapshot.status !== 'restoring' &&
        !(snapshot.status === 'connected' && snapshot.credentialMode === 'legacy_access_token'))
    ) {
      return
    }
    initialRefreshStarted = true
    void refreshUser()
  }
  const scheduleExpiry = () => {
    const scheduled = snapshot

    if (scheduled.status !== 'connected' || !scheduled.tokenExpiresAt) return
    if (scheduled.credentialMode === 'legacy_access_token') {
      let timer: number | undefined
      const expireWhenDue = () => {
        const remainingMs = scheduled.tokenExpiresAt! - Date.now()
        if (remainingMs > 0) {
          timer = window.setTimeout(expireWhenDue, Math.min(MAX_TIMER_DELAY_MS, remainingMs))
          return
        }
        setSnapshot(current =>
          current.status === 'connected' &&
          current.credentialMode === 'legacy_access_token' &&
          current.tokenExpiresAt === scheduled.tokenExpiresAt
            ? {
                ...current,
                status: 'expired',
                token: null,
                error: 'Cloud login has expired',
              }
            : current
        )
      }
      expireWhenDue()
      return () => {
        if (timer !== undefined) window.clearTimeout(timer)
      }
    }
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(
        ACCESS_TOKEN_REFRESH_RETRY_MS,
        scheduled.tokenExpiresAt - Date.now() - ACCESS_TOKEN_REFRESH_LEAD_MS
      )
    )
    const timer = window.setTimeout(() => {
      refreshAutomatically()
    }, delayMs)
    return () => window.clearTimeout(timer)
  }
  const scheduleRetry = () => {
    if (
      !desktopRestoreSettled ||
      snapshot.credentialMode !== 'desktop_refresh' ||
      !snapshot.apiBaseUrl ||
      (snapshot.status !== 'restoring' &&
        snapshot.status !== 'error' &&
        !(snapshot.status === 'connected' && snapshot.error))
    ) {
      return
    }
    const timer = window.setInterval(() => {
      refreshAutomatically()
    }, ACCESS_TOKEN_REFRESH_RETRY_MS)
    return () => window.clearInterval(timer)
  }
  const resume = () => {
    if (
      snapshot.apiBaseUrl &&
      (snapshot.status === 'connected' ||
        (snapshot.credentialMode === 'desktop_refresh' &&
          (snapshot.status === 'restoring' || snapshot.status === 'error')))
    )
      refreshAutomatically()
  }
  const restoreSelectedSession = () =>
    batch(() => {
      const config = getDesktopE2ERuntimeConfig()
      if (!config.controlUrl || config.disabled || !config.cloudToken) return
      // The controller has already verified /users/me and persisted the native
      // profile. Reuse normal connection consumers without remounting the app.
      ownerGeneration += 1
      candidateGeneration += 1
      disconnectEpoch += 1
      refreshAttemptSequence += 1
      inFlightRefresh = null
      disconnectRequested = false
      terminalCredentialExpiry = false
      initialRefreshStarted = true
      setAuthorization(null)
      setSnapshot(snapshotFromStored())
      e2eSessionRevision += 1
      dirty = true
    })
  function buildValue(): CloudConnectionContextValue {
    const activeSnapshot =
      snapshot.status === 'connected' && !readStoredCloudConnection()
        ? DISCONNECTED_STATE
        : snapshot
    const effectiveSnapshot =
      authorization && activeSnapshot.status !== 'connected'
        ? {
            ...activeSnapshot,
            status: 'connecting' as const,
            error: null,
          }
        : activeSnapshot
    const isConnected = effectiveSnapshot.status === 'connected' && Boolean(effectiveSnapshot.token)
    return {
      ...effectiveSnapshot,
      isConnected,
      serviceKey: isConnected
        ? `${effectiveSnapshot.apiBaseUrl ?? ''}:${effectiveSnapshot.tokenExpiresAt ?? ''}:${effectiveSnapshot.user?.id ?? ''}`
        : effectiveSnapshot.status,
      getTokenForAccount,
      connectWithAuthorization,
      refreshUser,
      disconnect,
    }
  }
  function getTokenForAccount(apiBaseUrl: string | undefined, userId: number | undefined) {
    return value.isConnected && value.apiBaseUrl === apiBaseUrl && value.user?.id === userId
      ? value.token
      : null
  }
  function updateValue() {
    const next = buildValue()
    const keys = Object.keys(next) as (keyof CloudConnectionContextValue)[]
    if (
      value &&
      Object.keys(value).length === keys.length &&
      keys.every(key => value[key] === next[key])
    )
      return false
    value = next
    return true
  }
  let reconciling = false
  let reconcileAgain = false
  function reconcile() {
    if (!listeners.size) return
    if (reconciling) {
      reconcileAgain = true
      return
    }
    reconciling = true
    try {
      do {
        reconcileAgain = false
        const nextConfig = [
          desktopRestoreSettled,
          e2eSessionRevision,
          snapshot.backendUrl,
          snapshot.socketBaseUrlOverride,
          snapshot.status,
        ]
        if (!same(configDependencies, nextConfig)) {
          configDependencies = nextConfig
          resolveConfiguration()
        }
        initialRefresh()
        const refreshInputs = [
          snapshot.apiBaseUrl,
          snapshot.backendUrl,
          snapshot.credentialMode,
          snapshot.socketBaseUrl,
          snapshot.socketPath,
          snapshot.token,
          snapshot.user,
          t,
        ]
        const nextExpiry = [...refreshInputs, snapshot.status, snapshot.tokenExpiresAt]
        if (!same(expiryDependencies, nextExpiry)) {
          expiryDependencies = nextExpiry
          stopExpiry?.()
          stopExpiry = scheduleExpiry()
        }
        const nextRetry = [...refreshInputs, desktopRestoreSettled, snapshot.error, snapshot.status]
        if (!same(retryDependencies, nextRetry)) {
          retryDependencies = nextRetry
          stopRetry?.()
          stopRetry = scheduleRetry()
        }
      } while (reconcileAgain)
    } finally {
      reconciling = false
    }
  }
  value = buildValue()
  return {
    getSnapshot: () => value,
    resume,
    restoreSelectedSession,
    subscribe(listener: () => void, translate: TFunction) {
      listeners.add(listener)
      t = translate
      if (listeners.size === 1 && !observing) {
        observing = true
        try {
          stopResume = subscribeSystemResume(resume)
        } catch (error) {
          console.error('[CloudConnection] Failed to observe system resume', error)
        }
        if (!rendererRestored) {
          rendererRestored = true
          try {
            setSnapshot(snapshotFromStored())
          } catch (error) {
            setSnapshot(current => ({
              ...current,
              status: 'error',
              token: null,
              error: getCloudErrorMessage(error, t),
            }))
          }
        }
        restoreDesktop()
      }
      updateValue()
      reconcile()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          lifetime += 1
          observing = false
          if (snapshot.status === 'restoring') initialRefreshStarted = false
          ownerGeneration += 1
          candidateGeneration += 1
          refreshAttemptSequence += 1
          inFlightRefresh = null
          if (!desktopRestoreSettled) desktopRestoreStarted = false
          stopResume?.()
          stopResume = undefined
          stopExpiry?.()
          stopExpiry = undefined
          stopRetry?.()
          stopRetry = undefined
          configDependencies = undefined
          expiryDependencies = undefined
          retryDependencies = undefined
        })
      }
    },
  }
}
