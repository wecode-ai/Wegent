import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import type { RemoteDeviceConnectionStatus } from '@/extensions/remote-device-onboarding-contract'
import {
  canUseForRemoteProjectCreation,
  isUsableDevice,
  isWeWorkExecutorVersionCompatible,
} from '@/lib/device-capabilities'
import { copyTextToClipboard } from '@/lib/clipboard'
import { track } from '@/telemetry/client'
import type { DeviceInfo, DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { DeviceOnboardingConnection } from './useDeviceOnboarding'
import type { useTranslation } from '@/hooks/useTranslation'

type Translate = ReturnType<typeof useTranslation>['t']
type PendingDevice = { cloud: true; id: number } | { cloud: false; deviceId: string }
type Notification =
  | { kind: 'busy' | 'creating' | 'pending'; value: boolean }
  | { kind: 'created'; id: number }
  | { kind: 'connected'; devices: DeviceInfo[]; device: DeviceInfo }

/** Completion handlers may finish asynchronously; their failures belong to this operation. */
export class DeviceOnboardingEvent extends Event {
  completion = Promise.resolve()
  readonly detail: Notification
  constructor(detail: Notification) {
    super('onboarding')
    this.detail = detail
  }
  complete(action: () => void | Promise<void>) {
    this.completion = Promise.resolve().then(action)
  }
}
interface OnboardingSnapshot {
  loading: boolean
  remoteLoading: boolean
  error: string | null
  remoteCommand: DockerRemoteDeviceCommandResponse | null
  pending: PendingDevice | null
  remoteStatus: RemoteDeviceConnectionStatus
  copied: boolean
}
const INITIAL: OnboardingSnapshot = {
  loading: false,
  remoteLoading: false,
  error: null,
  remoteCommand: null,
  pending: null,
  remoteStatus: 'idle',
  copied: false,
}
const IS_E2E = import.meta.env.VITE_WEWORK_E2E === 'true'
const POLL_INTERVAL_MS = IS_E2E ? 100 : 2000
const POLL_ATTEMPTS = IS_E2E ? 100 : 150
const REQUEST_TIMEOUT_MS = IS_E2E ? 1000 : 30_000

/** One account's onboarding owns mutation receipts, polling requests and their cancellation. */
export function createDeviceOnboardingSession(scope: string) {
  const events = new EventTarget()
  const listeners = new Set<() => void>()
  let snapshot = INITIAL
  let connection: DeviceOnboardingConnection | undefined
  let pollVersion = 0
  let operationVersion = 0
  let controller: AbortController | undefined
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  let requestTimer: ReturnType<typeof setTimeout> | undefined
  let releaseDelay: (() => void) | undefined
  let pollTranslation: Translate | undefined
  const emit = (detail: Notification) => {
    const event = new DeviceOnboardingEvent(detail)
    events.dispatchEvent(event)
    return event.completion
  }
  const publish = (patch: Partial<OnboardingSnapshot>) => {
    if (!listeners.size) return
    const previous = snapshot
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
    if (!listeners.size) return
    if (previous.loading !== snapshot.loading || previous.remoteLoading !== snapshot.remoteLoading)
      void emit({ kind: 'busy', value: snapshot.loading || snapshot.remoteLoading })
    if (Boolean(previous.pending) !== Boolean(snapshot.pending))
      void emit({ kind: 'pending', value: Boolean(snapshot.pending) })
  }
  const stopPoll = () => {
    pollVersion++
    controller?.abort()
    controller = undefined
    clearTimeout(requestTimer)
    requestTimer = undefined
    clearTimeout(delayTimer)
    delayTimer = undefined
    releaseDelay?.()
    releaseDelay = undefined
  }
  const api = () => {
    if (!connection?.isConnected || !connection.apiBaseUrl || !connection.token)
      throw new Error('Cloud connection is required')
    const { apiBaseUrl, token } = connection
    return createDeviceApi(
      createHttpClient({
        baseUrl: apiBaseUrl,
        getToken: () => token,
        redirectOnUnauthorized: false,
      })
    )
  }
  const poll = async (pending: PendingDevice, t: Translate) => {
    stopPoll()
    const version = pollVersion
    const current = () => version === pollVersion && listeners.size > 0
    publish({ remoteStatus: 'waiting' })
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      if (attempt > 0)
        await new Promise<void>(resolve => {
          releaseDelay = resolve
          delayTimer = setTimeout(() => {
            delayTimer = undefined
            releaseDelay = undefined
            resolve()
          }, POLL_INTERVAL_MS)
        })
      if (!current()) return
      const requestController = new AbortController()
      controller = requestController
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const devices = await Promise.race([
          api().getAllDevices({ signal: requestController.signal }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              requestController.abort()
              reject(new Error('Device polling timed out'))
            }, REQUEST_TIMEOUT_MS)
            requestTimer = timeout
          }),
        ])
        if (!current()) return
        const device = devices.find(item =>
          pending.cloud ? item.id === pending.id : item.device_id === pending.deviceId
        )
        if (!device) continue
        if (!isUsableDevice(device)) {
          publish({ remoteStatus: 'connecting' })
          continue
        }
        if (!isWeWorkExecutorVersionCompatible(device.executor_version)) {
          publish({ remoteStatus: 'version_mismatch' })
          return
        }
        if (!canUseForRemoteProjectCreation(device)) continue
        if (pending.cloud) void emit({ kind: 'creating', value: false })
        publish({ remoteStatus: 'online' })
        try {
          await emit({ kind: 'connected', devices, device })
        } catch (error) {
          if (current())
            publish({
              error:
                error instanceof Error
                  ? error.message
                  : t('workbench.device_onboarding_connection_failed'),
              remoteStatus: 'connection_failed',
            })
        }
        return
      } catch {
        if (!current()) return
      } finally {
        clearTimeout(timeout)
        if (requestTimer === timeout) requestTimer = undefined
        if (controller === requestController) controller = undefined
      }
    }
    if (current()) publish({ remoteStatus: 'connection_failed' })
  }
  const currentOperation = (version: number) => version === operationVersion && listeners.size > 0
  const create = async (cloud: boolean, hasCloudDevice: boolean, t: Translate) => {
    if (
      !listeners.size ||
      snapshot.loading ||
      snapshot.remoteLoading ||
      snapshot.pending?.cloud ||
      (cloud && hasCloudDevice) ||
      !connection?.isConnected ||
      !connection.apiBaseUrl ||
      !connection.token
    )
      return
    const version = ++operationVersion
    stopPoll()
    publish({
      loading: cloud,
      remoteLoading: !cloud,
      error: null,
      remoteCommand: null,
      copied: false,
      pending: null,
      remoteStatus: 'idle',
    })
    pollTranslation = t
    try {
      if (cloud) {
        const created = await api().createCloudDevice()
        if (!currentOperation(version)) return
        const pending = { cloud: true as const, id: created.id }
        publish({ pending })
        void emit({ kind: 'creating', value: true })
        track('feature_action_completed', { domain: 'cloud_device', action: 'create' })
        const completion = emit({ kind: 'created', id: created.id })
        void poll(pending, t)
        await completion
      } else {
        const command = await api().createDockerRemoteDeviceCommand()
        if (!currentOperation(version)) return
        const pending = { cloud: false as const, deviceId: command.device_id }
        publish({ remoteCommand: command, pending })
        track('feature_action_completed', { domain: 'cloud_device', action: 'create' })
        void poll(pending, t)
      }
    } catch (error) {
      if (!currentOperation(version)) return
      publish({
        error:
          error instanceof Error
            ? error.message
            : t(
                cloud
                  ? 'workbench.add_device_cloud_create_failed'
                  : 'workbench.remote_docker_generate_failed'
              ),
      })
      track('operation_failed', { operation: 'cloud_device_action' })
    } finally {
      if (currentOperation(version)) publish({ loading: false, remoteLoading: false })
    }
  }
  return {
    scope,
    events,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,
    subscribe(listener: () => void, nextConnection: DeviceOnboardingConnection) {
      connection = nextConnection
      listeners.add(listener)
      void emit({ kind: 'busy', value: snapshot.loading || snapshot.remoteLoading })
      void emit({ kind: 'pending', value: Boolean(snapshot.pending) })
      if (
        snapshot.pending &&
        pollTranslation &&
        (snapshot.remoteStatus === 'waiting' || snapshot.remoteStatus === 'connecting')
      )
        void poll(snapshot.pending, pollTranslation)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stopPoll()
          // Subscription replacement may preserve an accepted mutation in this account.
          queueMicrotask(() => {
            if (!listeners.size) operationVersion++
          })
        }
      }
    },
    createCloud: (hasCloudDevice: boolean, t: Translate) => create(true, hasCloudDevice, t),
    createRemote: (t: Translate) => create(false, false, t),
    retry(t: Translate) {
      if (snapshot.pending && listeners.size) {
        pollTranslation = t
        void poll(snapshot.pending, t)
      }
    },
    async copy(t: Translate) {
      const command = snapshot.remoteCommand
      const version = operationVersion
      if (!command || !listeners.size) return
      try {
        await copyTextToClipboard(command.command)
        if (currentOperation(version) && snapshot.remoteCommand === command)
          publish({ error: null, copied: true })
      } catch {
        if (currentOperation(version) && snapshot.remoteCommand === command)
          publish({ error: t('workbench.remote_docker_copy_failed') })
      }
    },
  }
}
