import { beginMobileDiagnostic, recordMobileDiagnostic } from '@/services/mobileDiagnostics'
import type { DeviceInfo } from '@/types/runtime'
import { withLocalRuntimeFileReferences } from '@/domain/localRuntimeFiles'
import { unwrapLocalRuntimeResponse } from './runtimeRpcResult'
import { mobileAbortError, throwIfAborted } from './mobileAbort'

export interface LocalRuntimeStatus {
  supported: boolean
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  accountScope?: string
  deviceId?: string
  generation: number
  background: 'notRequested' | 'active' | 'expired' | 'completed' | 'unavailable'
  error?: string | null
}

export interface LocalRuntimeEvent {
  sequence: number
  generation: number
  event: Record<string, unknown>
}

export interface NativeLocalRuntime {
  listProfilesAsync(): Promise<LocalRuntimeProfile[]>
  startAsync(input: {
    accountScope: string
    foregroundUserInitiated: boolean
  }): Promise<LocalRuntimeStatus>
  getStatusAsync(): Promise<LocalRuntimeStatus>
  requestAsync(input: {
    accountScope: string
    method: string
    params: Record<string, unknown>
    timeoutMs: number
    userWork?: { taskId: string; title: string }
  }): Promise<unknown>
  stopAsync(input: { accountScope: string }): Promise<void>
  importFileAsync(input: {
    accountScope: string
    uri: string
    name: string
  }): Promise<{ path: string; size: number }>
  getEventsAsync(input: { accountScope: string; afterSequence: number }): Promise<{
    events: LocalRuntimeEvent[]
    latestSequence: number
    hasMore?: boolean
  }>
  addListener(
    name: 'onRuntimeStatus',
    listener: (status: LocalRuntimeStatus) => void
  ): { remove(): void }
  addListener(
    name: 'onRuntimeEvent',
    listener: (event: LocalRuntimeEvent) => void
  ): { remove(): void }
}

export interface LocalRuntimeProfile {
  accountScope: string
  modifiedAt: number
}

export const UNAVAILABLE_LOCAL_RUNTIME: LocalRuntimeStatus = {
  supported: false,
  state: 'stopped',
  generation: 0,
  background: 'unavailable',
}

export function isPhoneLocalDeviceId(deviceId: unknown): boolean {
  return typeof deviceId === 'string' && deviceId.startsWith('mobile-local:')
}

/** Owns one phone environment's native transport; remote IDs never enter this bridge. */
export class LocalRuntime {
  private current: LocalRuntimeStatus
  private sequence = 0
  private startPending?: Promise<void>
  private runningRequested = false
  private readonly lifetime = new AbortController()
  private recoveryPending?: Promise<void>
  private recoveryBuffer?: { generation: number; events: Map<number, LocalRuntimeEvent> }
  private readonly statusListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: Record<string, unknown>) => void>()
  private readonly recoveryListeners = new Set<() => void>()
  private readonly subscriptions: { remove(): void }[] = []

  constructor(
    private readonly native: NativeLocalRuntime | null,
    readonly accountScope: string
  ) {
    this.current = { ...UNAVAILABLE_LOCAL_RUNTIME, supported: Boolean(native) }
  }

  private attach(): void {
    if (this.subscriptions.length || !this.native) return
    this.subscriptions.push(
      this.native.addListener('onRuntimeStatus', status => this.receiveStatus(status)),
      this.native.addListener('onRuntimeEvent', event => this.receiveEvent(event))
    )
  }

  get status(): LocalRuntimeStatus {
    return this.current
  }

  async initialize(): Promise<void> {
    throwIfAborted(this.lifetime.signal)
    if (!this.native) return
    this.attach()
    const diagnostic = beginMobileDiagnostic('phone-initialize', 'phone')
    try {
      const status = await this.native.getStatusAsync()
      throwIfAborted(this.lifetime.signal)
      this.receiveStatus(status)
      diagnostic.complete({ generation: status.generation })
    } catch (cause) {
      diagnostic.fail(cause)
      throw cause
    }
  }

  async start(): Promise<void> {
    throwIfAborted(this.lifetime.signal)
    this.runningRequested = true
    if (this.startPending) return this.startPending
    this.attach()
    const native = this.requireNative()
    const diagnostic = beginMobileDiagnostic('phone-start', 'phone')
    this.startPending = (async () => {
      diagnostic.step('read-native-status')
      let existing = await native.getStatusAsync()
      this.assertStartRequested()
      if (existing.state === 'stopping') {
        diagnostic.step('wait-for-stop')
        await this.waitForStop()
        existing = await native.getStatusAsync()
        this.assertStartRequested()
      }
      if (
        existing.accountScope &&
        existing.state !== 'stopped' &&
        (existing.accountScope !== this.accountScope || existing.state === 'failed')
      ) {
        diagnostic.step('stop-previous-runtime')
        await native.stopAsync({ accountScope: existing.accountScope })
      }
      this.assertStartRequested()
      diagnostic.step('start-native-runtime')
      const started = await native.startAsync({
        accountScope: this.accountScope,
        foregroundUserInitiated: false,
      })
      this.assertStartRequested()
      this.receiveStatus(started)
      if (this.current.state !== 'running')
        throw new Error(this.current.error || '本机执行环境启动失败')
      diagnostic.step('recover-events')
      await this.recover()
      diagnostic.complete({ generation: this.current.generation })
    })()
      .catch(cause => {
        diagnostic.fail(cause)
        throw cause
      })
      .finally(() => {
        this.startPending = undefined
      })
    return this.startPending
  }

  async stop(): Promise<void> {
    this.runningRequested = false
    const native = this.requireNative()
    await native.stopAsync({ accountScope: this.accountScope })
    this.receiveStatus(await native.getStatusAsync())
  }

  async resume(): Promise<void> {
    await this.initialize()
    if (this.current.supported && this.runningRequested) await this.start()
  }

  private assertStartRequested(): void {
    throwIfAborted(this.lifetime.signal)
    if (!this.runningRequested) throw mobileAbortError()
  }

  private waitForStop(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (cause?: unknown) => {
        unsubscribe()
        this.lifetime.signal.removeEventListener('abort', onAbort)
        if (cause) reject(cause)
        else resolve()
      }
      const onAbort = () => finish(mobileAbortError())
      const receive = (status: LocalRuntimeStatus) => {
        if (status.state === 'stopped') finish()
        else if (status.state === 'failed')
          finish(new Error(status.error || '本机执行环境停止失败'))
      }
      const check = () => {
        void this.requireNative().getStatusAsync().then(receive, finish)
      }
      const unsubscribe = this.onStatus(() => {
        if (this.current.state === 'stopped') receive(this.current)
        else if (this.current.state === 'failed') check()
      })
      this.lifetime.signal.addEventListener('abort', onAbort, { once: true })
      if (this.lifetime.signal.aborted) onAbort()
      else check()
    })
  }

  ownsDevice(deviceId: string | undefined): boolean {
    return Boolean(
      deviceId &&
      this.current.accountScope === this.accountScope &&
      this.current.deviceId === deviceId
    )
  }

  device(): DeviceInfo | null {
    if (!this.current.deviceId || this.current.accountScope !== this.accountScope) return null
    return {
      // This is a host-owned record, never a Backend registration ID.
      id: -1,
      device_id: this.current.deviceId,
      name: '这台手机',
      device_type: 'local',
      bind_shell: 'claudecode',
      status: this.current.state === 'running' ? 'online' : 'offline',
      runtime_features: { schemaVersion: 1, embeddedRuntime: { version: 1 } },
    }
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 75_000): Promise<T> {
    return this.dispatchRequest(method, params, timeoutMs)
  }

  requestUserWork<T>(
    taskId: string,
    title: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 75_000
  ): Promise<T> {
    // Native owns lease acquisition and dispatch as one operation. Splitting
    // these across JS calls lets an old terminal event release a new turn.
    return this.dispatchRequest(method, params, timeoutMs, { taskId, title })
  }

  private async dispatchRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    userWork?: { taskId: string; title: string }
  ): Promise<T> {
    if (this.current.accountScope !== this.accountScope || this.current.state !== 'running')
      throw new Error(this.current.error || '请先在设置中启动本机执行环境')
    const generation = this.current.generation
    const deviceId = this.current.deviceId!
    const result = await this.requireNative().requestAsync({
      accountScope: this.accountScope,
      method,
      params,
      timeoutMs,
      ...(userWork ? { userWork } : {}),
    })
    if (this.current.generation !== generation || !this.ownsDevice(deviceId))
      throw new Error('请求期间本机执行环境已变化，请刷新后重试')
    return withLocalRuntimeFileReferences(await unwrapLocalRuntimeResponse<T>(result), deviceId)
  }

  importFile(uri: string, name: string): Promise<{ path: string; size: number }> {
    if (this.current.state !== 'running' || this.current.accountScope !== this.accountScope)
      throw new Error('请先启动本机执行环境')
    return this.requireNative().importFileAsync({ accountScope: this.accountScope, uri, name })
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onRecovery(listener: () => void): () => void {
    this.recoveryListeners.add(listener)
    return () => {
      this.recoveryListeners.delete(listener)
    }
  }

  recover(): Promise<void> {
    if (this.recoveryPending) return this.recoveryPending
    this.recoveryBuffer ??= { generation: this.current.generation, events: new Map() }
    recordMobileDiagnostic('[LocalRuntime] Recovery started', () => this.transportDiagnostics())
    const pending = this.recoverEvents()
      .then(() => {
        recordMobileDiagnostic('[LocalRuntime] Recovery completed', () =>
          this.transportDiagnostics()
        )
      })
      .catch(cause => {
        recordMobileDiagnostic('[LocalRuntime] Recovery failed', () => this.transportDiagnostics())
        throw cause
      })
      .finally(() => {
        if (this.recoveryPending === pending) this.recoveryPending = undefined
      })
    this.recoveryPending = pending
    return pending
  }

  private async recoverEvents(): Promise<void> {
    await this.initialize()
    if (this.current.state !== 'running') {
      this.recoveryBuffer = undefined
      return
    }
    const buffer = this.recoveryBuffer!
    let cursor = this.sequence
    let page
    do {
      page = await this.requireNative().getEventsAsync({
        accountScope: this.accountScope,
        afterSequence: cursor,
      })
      if (
        buffer !== this.recoveryBuffer ||
        this.current.generation !== buffer.generation ||
        this.current.state !== 'running' ||
        this.current.accountScope !== this.accountScope
      )
        throw new Error('恢复期间本机执行环境已变化，请重新刷新')
      const previousCursor = cursor
      for (const event of page.events) {
        if (event.generation !== buffer.generation || event.sequence <= cursor) continue
        buffer.events.set(event.sequence, event)
        cursor = event.sequence
      }
      if (page.hasMore && cursor === previousCursor)
        throw new Error('本机事件日志无法继续读取，请重新刷新')
    } while (page.hasMore)
    // Commit the replay watermark only after every page succeeds. On failure,
    // keep buffering live events so a retry can still retrieve the missing prefix.
    this.recoveryBuffer = undefined
    for (const event of [...buffer.events.values()].sort((a, b) => a.sequence - b.sequence))
      this.receiveEvent(event)
    this.recoveryListeners.forEach(listener => listener())
  }

  dispose(): void {
    recordMobileDiagnostic('[LocalRuntime] Transport disposed', () => this.transportDiagnostics())
    this.lifetime.abort()
    this.subscriptions.forEach(subscription => subscription.remove())
    this.subscriptions.length = 0
    this.statusListeners.clear()
    this.eventListeners.clear()
    this.recoveryListeners.clear()
    this.recoveryBuffer = undefined
  }

  private receiveStatus(status: LocalRuntimeStatus): void {
    if (status.accountScope && status.accountScope !== this.accountScope)
      status = { ...UNAVAILABLE_LOCAL_RUNTIME, supported: status.supported }
    if (status.generation !== this.current.generation) {
      this.sequence = 0
      if (this.recoveryBuffer)
        this.recoveryBuffer = { generation: status.generation, events: new Map() }
    }
    if (status.state !== this.current.state || status.generation !== this.current.generation)
      recordMobileDiagnostic('[LocalRuntime] Status changed', {
        previousState: this.current.state,
        state: status.state,
        generation: status.generation,
      })
    this.current = status
    this.statusListeners.forEach(listener => listener())
  }

  private transportDiagnostics() {
    return {
      state: this.current.state,
      generation: this.current.generation,
      sequence: this.sequence,
      bufferedEvents: this.recoveryBuffer?.events.size ?? 0,
      buffering: Boolean(this.recoveryBuffer),
      eventListeners: this.eventListeners.size,
    }
  }

  private receiveEvent(envelope: LocalRuntimeEvent): void {
    if (
      this.current.accountScope !== this.accountScope ||
      envelope.generation !== this.current.generation ||
      envelope.sequence <= this.sequence
    )
      return
    if (this.recoveryBuffer) {
      this.recoveryBuffer.events.set(envelope.sequence, envelope)
      return
    }
    if (this.sequence && envelope.sequence !== this.sequence + 1)
      this.recoveryListeners.forEach(listener => listener())
    this.sequence = envelope.sequence
    const event = envelope.event
    if (event.event === 'executor.event_lagged') {
      this.recoveryListeners.forEach(listener => listener())
      return
    }
    // Local IPC events may omit device identity; this bridge owns exactly one runtime.
    const payload = event.payload
    if (payload && typeof payload === 'object' && !Array.isArray(payload))
      this.eventListeners.forEach(listener =>
        listener({
          ...event,
          payload: withLocalRuntimeFileReferences(
            { ...payload, deviceId: this.current.deviceId },
            this.current.deviceId!
          ),
        })
      )
  }

  private requireNative(): NativeLocalRuntime {
    if (!this.native) throw new Error('此安装包尚不支持手机本地执行')
    return this.native
  }
}
