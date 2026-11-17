import type { LocalRuntime } from './localRuntime'

export interface CodexDeviceLogin {
  type: 'chatgptDeviceCode'
  loginId: string
  verificationUrl: string
  userCode: string
  processGeneration: number
  authUrl?: never
}

export interface CodexBrowserLogin {
  type: 'chatgpt'
  loginId: string
  authUrl: string
  processGeneration: number
  userCode?: never
  verificationUrl?: never
}
export type CodexLogin = CodexDeviceLogin | CodexBrowserLogin

const sessions = new WeakMap<object, LocalCodexLogin>()

/** A pending official login belongs to its runtime, not to a settings page mount. */
export function localCodexLogin(
  runtime: Pick<LocalRuntime, 'request' | 'onEvent'>
): LocalCodexLogin {
  let session = sessions.get(runtime)
  if (!session) {
    session = new LocalCodexLogin(runtime)
    sessions.set(runtime, session)
  }
  return session
}

interface LoginCompletion {
  loginId: string
  success: boolean
  error?: string | null
  processGeneration?: number
}

/** Completion comes from Codex, never from the presence of a previously signed-in account. */
export class LocalCodexLogin {
  private current: { login: CodexLogin | null; error: string | null; completed: number } = {
    login: null,
    error: null,
    completed: 0,
  }
  private starting = false
  private revision = 0
  private readonly early = new Map<string, LoginCompletion>()
  private readonly earlyExits = new Set<number>()
  private readonly listeners = new Set<() => void>()
  private unsubscribe?: () => void

  constructor(private readonly runtime: Pick<LocalRuntime, 'request' | 'onEvent'>) {}

  connect(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.runtime.onEvent(event => {
      const payload = event.payload as Record<string, unknown> | undefined
      if (!payload) return
      if (
        event.event === 'runtime.codex.auth.login.completed' &&
        typeof payload.loginId === 'string' &&
        typeof payload.success === 'boolean'
      ) {
        const completion = payload as unknown as LoginCompletion
        if (this.starting) this.early.set(completion.loginId, completion)
        else this.complete(completion)
      } else if (
        event.event === 'runtime.codex.app_server.exited' &&
        typeof payload.processGeneration === 'number'
      ) {
        if (this.starting) this.earlyExits.add(payload.processGeneration)
        if (this.current.login?.processGeneration === payload.processGeneration) {
          this.current = { ...this.current, login: null, error: 'Codex 已退出，请重新登录' }
          this.publish()
        }
      }
    })
  }

  get snapshot() {
    return this.current
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(type: CodexLogin['type'] = 'chatgptDeviceCode'): Promise<CodexLogin> {
    this.connect()
    if (this.starting || this.current.login) throw new Error('已有 Codex 登录正在进行')
    const revision = ++this.revision
    this.starting = true
    this.early.clear()
    this.earlyExits.clear()
    this.current = { ...this.current, error: null }
    this.publish()
    try {
      const response = await this.runtime.request<CodexLogin>('runtime.codex.auth.login.start', {
        type,
      })
      if (revision !== this.revision) throw new Error('登录已中断')
      if (
        response.type !== type ||
        !response.loginId ||
        (response.type === 'chatgptDeviceCode'
          ? !response.userCode || !response.verificationUrl
          : !response.authUrl) ||
        !Number.isSafeInteger(response.processGeneration)
      )
        throw new Error('Codex 返回了无效的设备登录信息')
      const url = new URL(response.type === 'chatgpt' ? response.authUrl : response.verificationUrl)
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com')
        throw new Error('Codex 返回了非官方登录地址')
      this.current = { ...this.current, login: response }
      const completion = this.early.get(response.loginId)
      if (completion) this.complete(completion)
      else if (this.earlyExits.has(response.processGeneration)) {
        this.current = { ...this.current, login: null, error: 'Codex 已退出，请重新登录' }
        this.publish()
      } else this.publish()
      return response
    } finally {
      this.starting = false
      this.early.clear()
      this.earlyExits.clear()
    }
  }

  async cancel(): Promise<void> {
    const login = this.current.login
    if (!login) return
    const response = await this.runtime.request<{ status: string }>(
      'runtime.codex.auth.login.cancel',
      { loginId: login.loginId }
    )
    if (!['canceled', 'notFound'].includes(response.status)) throw new Error('Codex 未确认取消登录')
    if (this.current.login?.loginId === login.loginId) this.reset()
  }

  reset(): void {
    this.revision += 1
    this.early.clear()
    this.current = { ...this.current, login: null, error: null }
    this.publish()
  }

  dispose(): void {
    this.revision += 1
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.listeners.clear()
  }

  private complete(completion: LoginCompletion): void {
    const login = this.current.login
    if (!login || completion.loginId !== login.loginId) return
    if (login.processGeneration != null && completion.processGeneration !== login.processGeneration)
      return
    this.current = {
      login: null,
      error: completion.success ? null : completion.error || 'Codex 登录未完成，请重试',
      completed: this.current.completed + (completion.success ? 1 : 0),
    }
    this.publish()
  }

  private publish(): void {
    this.listeners.forEach(listener => listener())
  }
}
