import type { WebContents } from 'electron'

type Request = Record<string, unknown>

/** The native owner survives renderer failure and releases pending acquisitions in order. */
export class McpAppSessions {
  private disposed = false
  private readonly sessions = new Map<
    string,
    {
      generation: number | null
      ready: Promise<unknown>
      dispose: () => void
      payload: Request
      cleanups: Array<() => void>
      releasing?: Promise<void>
    }
  >()

  constructor(
    private readonly request: (payload: Request) => Promise<unknown>,
    private readonly generation: (payload: Request) => number | null = () => 0
  ) {}

  async retain(id: string, payload: Request, owner: WebContents): Promise<void> {
    if (this.disposed) throw new Error('MCP App owner is shutting down')
    if (!id) throw new Error('Invalid MCP App session')
    const existing = this.sessions.get(id)
    if (existing) {
      if (existing.releasing) throw new Error('MCP App session is closing')
      if (existing.generation === null || existing.generation !== this.generation(payload)) {
        existing.generation = this.generation(payload)
        existing.ready = existing.ready
          .catch(() => {})
          .then(() => this.request({ ...existing.payload, method: 'retain', sessionId: id }))
          .catch(error => {
            existing.generation = null
            throw error
          })
      }
      await existing.ready
      return
    }
    const release = () => {
      void this.release(id).catch(error => {
        console.error('[Wework] MCP App owner cleanup failed', { name: error.name })
      })
    }
    const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !_inPlace) release()
    }
    owner.once('destroyed', release)
    owner.once('render-process-gone', release)
    owner.on('did-start-navigation', navigation)
    const dispose = () => {
      owner.removeListener('destroyed', release)
      owner.removeListener('render-process-gone', release)
      owner.removeListener('did-start-navigation', navigation)
    }
    const ready = Promise.resolve().then(() =>
      this.request({ ...payload, method: 'retain', sessionId: id })
    )
    this.sessions.set(id, {
      ready,
      dispose,
      payload,
      generation: this.generation(payload),
      cleanups: [],
    })
    try {
      await ready
    } catch (error) {
      const failed = this.sessions.get(id)
      if (failed) failed.generation = null
      await this.release(id).catch(cleanupError => {
        console.info('[Wework] MCP App acquisition cleanup failed', {
          name: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
        })
      })
      throw error
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.sessions.keys()].map(id => this.release(id)))
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  attach(id: string, cleanup: () => void): void {
    const session = this.sessions.get(id)
    if (!session || session.releasing) {
      cleanup()
      throw new Error('MCP App session is closed')
    }
    session.cleanups.push(cleanup)
  }

  async release(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.releasing) return session.releasing
    session.cleanups.splice(0).forEach(cleanup => cleanup())
    session.releasing = (async () => {
      await session.ready.catch(() => {})
      await this.request({ ...session.payload, method: 'release', sessionId: id })
      this.sessions.delete(id)
      session.dispose()
    })().catch(error => {
      session.releasing = undefined
      throw error
    })
    return session.releasing
  }
}

/** Use the host's standard five-second process stop grace period. */
export async function settleMcpAppCleanup(
  cleanups: Iterable<() => Promise<void>>,
  timeoutMs = 5_000
): Promise<PromiseSettledResult<void>[]> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.allSettled([...cleanups].map(cleanup => Promise.resolve().then(cleanup))),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('MCP App cleanup timed out')), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
