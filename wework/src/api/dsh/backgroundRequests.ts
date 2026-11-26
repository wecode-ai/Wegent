export type DshRequestPriority = 'foreground' | 'background'

const BACKGROUND_SLOTS = ['wework.dsh.background.0', 'wework.dsh.background.1'] as const
export const DSH_BACKGROUND_CONCURRENCY = BACKGROUND_SLOTS.length
const BACKGROUND_QUEUE_TIMEOUT_MS = 30_000

// Allow the DSH-to-executor deadline to report its error before closing HTTP.
export function dshRpcTimeoutMs(method: string): number {
  if (method === 'runtime.connections.web.trial') return 320_000
  if (method === 'runtime.connections.web.install') return 16 * 60_000 + 20_000
  const preparesPython =
    method === 'executor.plugin_auth.migrate' ||
    method === 'executor.plugin_auth.run' ||
    method === 'runtime.connections.cli' ||
    method.startsWith('runtime.local_connector_auth.')
  return preparesPython ? 21 * 60_000 + 10_000 : 125_000
}

interface BackgroundRequestDiagnostic {
  requestId: string
  method: string
  command?: string
}

/** Reserve sockets before fetch, across every renderer sharing the DSH origin. */
export function scheduleDshRequest<T>(
  priority: DshRequestPriority,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  locks: LockManager = navigator.locks,
  diagnostic?: BackgroundRequestDiagnostic
): Promise<T> {
  if (priority === 'foreground') return operation()
  const enqueuedAt = performance.now()
  const log = (stage: string, details: Record<string, number | string | boolean> = {}) => {
    if (diagnostic) {
      console.info(
        '[Wework] Executor transport diagnostic ' +
          JSON.stringify({
            ...diagnostic,
            stage,
            ...details,
          })
      )
    }
  }
  log('background_queued')
  return new Promise<T>((resolve, reject) => {
    const waiting = new AbortController()
    const queueDeadline = AbortSignal.timeout(BACKGROUND_QUEUE_TIMEOUT_MS)
    const cancellation = AbortSignal.any(
      signal ? [signal, waiting.signal, queueDeadline] : [waiting.signal, queueDeadline]
    )
    let claimed = false
    for (const name of BACKGROUND_SLOTS) {
      let acquiredAt: number | undefined
      let ok = false
      void locks
        .request(name, { signal: cancellation }, async () => {
          if (claimed) return
          claimed = true
          const heldSince = performance.now()
          acquiredAt = heldSince
          log('background_acquired', {
            slot: name,
            queueMs: Math.round(acquiredAt - enqueuedAt),
            released: false,
          })
          // Cancel the other queued slot; the granted lock lives until the body is consumed.
          waiting.abort()
          const slowHold = diagnostic
            ? setTimeout(() => {
                log('background_still_held', {
                  slot: name,
                  heldMs: Math.round(performance.now() - heldSince),
                  released: false,
                })
              }, 10_000)
            : undefined
          try {
            const result = await operation()
            ok = true
            resolve(result)
          } catch (error) {
            reject(error)
          } finally {
            if (slowHold !== undefined) clearTimeout(slowHold)
          }
        })
        .then(() => {
          if (acquiredAt === undefined) return
          log('background_released', {
            slot: name,
            queueMs: Math.round(acquiredAt - enqueuedAt),
            heldMs: Math.round(performance.now() - acquiredAt),
            released: true,
            ok,
          })
        })
        .catch(error => {
          if (claimed) return
          claimed = true
          waiting.abort()
          log('background_wait_ended', {
            queueMs: Math.round(performance.now() - enqueuedAt),
            reason: queueDeadline.aborted ? 'timeout' : signal?.aborted ? 'cancelled' : 'error',
          })
          reject(error)
        })
    }
  })
}

export function executorRequestPriority(
  method: string,
  params: Record<string, unknown>
): DshRequestPriority {
  // Passive MCP App discovery fans out once per historical tool call when a
  // transcript mounts. Keep it on the shared background lanes so it cannot
  // occupy the interactive RPC path. App actions still stay foreground.
  if (method === 'runtime.mcp_apps.request') {
    const appMethod = params.method
    return appMethod === undefined || appMethod === null || appMethod === 'discover'
      ? 'background'
      : 'foreground'
  }
  if (method === 'device.execute_command') {
    const command = String(params.command_key ?? '')
    return command.startsWith('connection_observer_') ||
      BACKGROUND_DEVICE_COMMANDS.has(command) ||
      command === 'runtime_auth_status'
      ? 'background'
      : 'foreground'
  }
  return BACKGROUND_EXECUTOR_METHODS.has(method) ? 'background' : 'foreground'
}

const BACKGROUND_DEVICE_COMMANDS = new Set([
  'git_branch',
  'git_branch_diff',
  'git_branch_diff_shortstat',
  'git_diff',
  'git_diff_last_commit',
  'git_diff_staged',
  'git_diff_unstaged',
  'git_github_cli_status',
  'git_gitlab_cli_status',
  'git_is_worktree',
  'git_remote_url',
  'git_status_porcelain',
])

const BACKGROUND_EXECUTOR_METHODS = new Set([
  'runtime.tasks.list',
  'runtime.stand_in.work.list',
  'runtime.stand_in.telemetry.list',
  'runtime.tasks.archive',
  'runtime.codex.plugin.sync_bundled',
  'executor.plugins.initialize_bundled_marketplace',
])
