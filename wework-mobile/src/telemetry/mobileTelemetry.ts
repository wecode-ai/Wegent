import * as Crypto from 'expo-crypto'
import type { MobileTelemetryConfig } from './config'
import { getMobileTelemetryConfig } from './runtimeConfig'
import { MobileTelemetryClient, type MobileTelemetryEventProperties } from './client'
import type { MobileAnalyticsEventMap, MobileAnalyticsEventName, MobileScreen } from './events'
import {
  beginForeground,
  clearForeground,
  endForeground,
  heartbeatForeground,
  prepareLaunch,
  resetTelemetryIdentity,
  type MobileTelemetryState,
} from './state'
import { MobileTelemetryStateStore } from './stateStore'
import { fileTelemetryStorage } from './stateFileStorage'

export interface MobileTelemetrySnapshot {
  ready: boolean
  available: boolean
  asked: boolean
  enabled: boolean
  saving: boolean
  active: boolean
  error: unknown | null
}

const INITIAL_SNAPSHOT: MobileTelemetrySnapshot = {
  ready: false,
  available: false,
  asked: false,
  enabled: false,
  saving: false,
  active: false,
  error: null,
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export class MobileTelemetryController {
  private snapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private readonly stateStore = new MobileTelemetryStateStore(fileTelemetryStorage())
  private readonly client = new MobileTelemetryClient()
  private config: MobileTelemetryConfig | null = null
  private state: MobileTelemetryState | null = null
  private sessionId: string | null = null
  private loading: Promise<void> | null = null
  private starting: Promise<boolean> | null = null
  private stopping: Promise<void> | null = null
  private pendingStartupDurationMs: number | null = null
  private pendingLaunch: ReturnType<typeof prepareLaunch> | null = null
  private launchPrepared = false
  private consentGeneration = 0

  getSnapshot = (): MobileTelemetrySnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(): Promise<void> {
    this.loading ??= this.loadInternal()
    return this.loading
  }

  async choose(enabled: boolean): Promise<void> {
    if (!this.snapshot.available || this.snapshot.saving) return
    this.consentGeneration += 1
    this.publish({ saving: true, enabled, error: null })
    try {
      if (!enabled) await this.stopClient()
      const next = await this.stateStore.update(state => {
        const base = enabled ? state : resetTelemetryIdentity(state)
        return {
          state: { ...base, consentAsked: true, consentEnabled: enabled },
          result: { ...base, consentAsked: true, consentEnabled: enabled },
        }
      })
      this.state = next
      this.publish({ asked: true, enabled, active: false })
      if (enabled && (await this.start())) {
        this.capture('mobile_telemetry_preference_changed', { enabled: true })
      }
    } catch (error) {
      await this.stopClient()
      this.publish({ asked: true, enabled: false, active: false, error })
      throw error
    } finally {
      this.publish({ saving: false })
    }
  }

  async retry(): Promise<void> {
    this.publish({ error: null })
    if (!this.snapshot.ready || !this.snapshot.available) {
      this.loading = null
      await this.load()
    }
    if (this.snapshot.enabled && !this.snapshot.active) await this.start()
  }

  start(): Promise<boolean> {
    if (
      !this.snapshot.ready ||
      !this.snapshot.available ||
      !this.snapshot.enabled ||
      this.snapshot.active ||
      this.launchPrepared
    ) {
      return Promise.resolve(this.snapshot.active)
    }
    this.starting ??= this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stop(): Promise<void> {
    this.consentGeneration += 1
    await this.stopClient()
    if (!this.state) return
    this.state = await this.stateStore.update(state => {
      const next = resetTelemetryIdentity(state)
      return { state: next, result: next }
    })
    this.publish({ active: false })
  }

  beginForeground(): void {
    if (!this.active || !this.state) return
    const now = Date.now()
    this.capture('mobile_foreground_started', { resumed: true })
    void this.stateStore
      .update(state => {
        const next = beginForeground(state, now)
        return { state: next, result: next }
      })
      .then(next => {
        this.state = next
      })
      .catch(error => this.publish({ error }))
  }

  endForeground(): void {
    if (!this.active || !this.state) return
    void this.stateStore
      .update(state => {
        const ended = endForeground(state, Date.now())
        if (!ended) return { state, result: null }
        return {
          state: ended.state,
          result: ended.durationMs,
        }
      })
      .then(durationMs => {
        if (durationMs === null) return
        this.capture('mobile_foreground_ended', {
          duration_ms: Math.round(durationMs),
          termination: 'background',
        })
        return this.client.flush()
      })
      .catch(error => this.publish({ error }))
  }

  heartbeat(): void {
    if (!this.active || !this.state) return
    void this.stateStore
      .update(state => {
        const next = heartbeatForeground(state, Date.now())
        return { state: next, result: next }
      })
      .then(next => {
        this.state = next
      })
      .catch(error => this.publish({ error }))
  }

  recordStartup(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 5 * 60_000) return
    const rounded = Math.round(durationMs)
    if (!this.active) {
      this.pendingStartupDurationMs = rounded
      return
    }
    this.capture('mobile_startup_completed', { duration_ms: rounded })
  }

  recordFrameHealth(properties: MobileAnalyticsEventMap['mobile_frame_health']): void {
    this.capture('mobile_frame_health', properties)
  }

  recordScreen(screen: MobileScreen): void {
    this.capture('mobile_screen_viewed', { screen })
  }

  track<EventName extends MobileAnalyticsEventName>(
    name: EventName,
    properties: MobileAnalyticsEventMap[EventName]
  ): void {
    this.capture(name, properties)
  }

  flush(): void {
    if (!this.active) return
    void this.client.flush().catch(() => undefined)
  }

  private get active(): boolean {
    return this.snapshot.active
  }

  private async loadInternal(): Promise<void> {
    try {
      this.config = getMobileTelemetryConfig()
      if (!this.config.available) {
        this.publish({ ready: true, available: false })
        return
      }
      this.state = await this.stateStore.load()
      this.publish({
        ready: true,
        available: true,
        asked: this.state.consentAsked,
        enabled: this.state.consentEnabled,
        error: null,
      })
    } catch (error) {
      this.publish({ ready: true, available: false, error })
    }
  }

  private async startInternal(): Promise<boolean> {
    const config = this.config
    if (!config?.available) return false
    const generation = this.consentGeneration
    try {
      let prepared: ReturnType<typeof prepareLaunch> | null = null
      this.state = await this.stateStore.update(state => {
        if (!state.consentEnabled) return { state, result: state }
        prepared =
          this.pendingLaunch ??
          prepareLaunch(state, config.appVersion, Date.now(), Crypto.randomUUID)
        this.pendingLaunch = prepared
        return { state: prepared.state, result: prepared.state }
      })
      if (!prepared) return false
      const launch: ReturnType<typeof prepareLaunch> = prepared
      if (launch.state.sampleBucket === null || launch.state.sampleBucket >= config.sampleRate) {
        this.launchPrepared = true
        this.pendingLaunch = null
        return false
      }
      if (generation !== this.consentGeneration || !this.snapshot.enabled) return false
      this.sessionId = sessionId(Crypto.randomUUID())
      await this.client.start(config, launch.state.installationId!, {
        ...this.commonProperties(config, this.sessionId),
      })
      if (generation !== this.consentGeneration || !this.snapshot.enabled) {
        await this.client.stop()
        return false
      }
      this.launchPrepared = true
      this.pendingLaunch = null
      this.publish({ active: true, error: null })
      this.captureLaunch(launch, config)
      return true
    } catch (error) {
      this.launchPrepared = false
      this.publish({ active: false, error })
      return false
    }
  }

  private captureLaunch(
    launch: ReturnType<typeof prepareLaunch>,
    config: MobileTelemetryConfig
  ): void {
    if (launch.previousForegroundDurationMs !== null) {
      this.capture('mobile_session_abnormal_end', {
        duration_ms: Math.round(launch.previousForegroundDurationMs),
      })
    }
    if (launch.installationEvent === 'installed') {
      this.capture('mobile_app_installed', {
        is_first_launch: true,
        since_install_ms: launch.sinceInstallMs,
      })
    } else if (launch.installationEvent === 'updated') {
      this.capture('mobile_app_updated', {
        from_version: launch.previousVersion ?? 'unknown',
        to_version: config.appVersion,
      })
    }
    this.capture('mobile_app_opened', {
      cold_start: true,
      launch_count: launch.state.launchCount,
      is_first_launch: launch.isFirstLaunch,
      since_install_ms: launch.sinceInstallMs,
    })
    if (this.pendingStartupDurationMs !== null) {
      this.capture('mobile_startup_completed', {
        duration_ms: this.pendingStartupDurationMs,
      })
      this.pendingStartupDurationMs = null
    }
  }

  private commonProperties(
    config: MobileTelemetryConfig,
    telemetrySessionId: string
  ): MobileTelemetryEventProperties {
    return {
      $geoip_disable: true,
      app_build: config.appBuild,
      app_version: config.appVersion,
      environment: config.environment,
      event_schema_version: 1,
      locale: config.locale,
      os: config.platform,
      os_version: config.osVersion,
      platform: config.platform,
      release_channel: config.releaseChannel,
      telemetry_sample_rate: config.sampleRate,
      telemetry_session_id: telemetrySessionId,
      telemetry_source: config.source,
    }
  }

  private capture<EventName extends MobileAnalyticsEventName>(
    name: EventName,
    properties: MobileAnalyticsEventMap[EventName]
  ): void {
    if (!this.active) return
    this.client.capture(name, properties)
  }

  private async stopClient(): Promise<void> {
    this.stopping ??= this.client
      .stop()
      .catch(error => {
        this.publish({ error })
      })
      .finally(() => {
        this.stopping = null
      })
    await this.stopping
    this.sessionId = null
    this.pendingLaunch = null
    this.launchPrepared = false
    this.publish({ active: false })
    if (this.state) {
      try {
        this.state = await this.stateStore.update(state => {
          const next = clearForeground(state)
          return { state: next, result: next }
        })
      } catch (error) {
        this.publish({ error })
      }
    }
  }

  private publish(patch: Partial<MobileTelemetrySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function sessionId(value: string): string {
  return SESSION_ID_PATTERN.test(value) ? value : value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
}

export const mobileTelemetry = new MobileTelemetryController()
