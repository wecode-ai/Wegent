export type DshRequestPriority = 'foreground' | 'background'

const BACKGROUND_SLOTS = ['wework.dsh.background.0', 'wework.dsh.background.1'] as const

/** Reserve sockets before fetch, across every renderer sharing the DSH origin. */
export function scheduleDshRequest<T>(
  priority: DshRequestPriority,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  locks: LockManager = navigator.locks
): Promise<T> {
  if (priority === 'foreground') return operation()
  return new Promise<T>((resolve, reject) => {
    const waiting = new AbortController()
    const cancellation = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal
    let claimed = false
    for (const name of BACKGROUND_SLOTS) {
      void locks
        .request(name, { signal: cancellation }, async () => {
          if (claimed) return
          claimed = true
          // Cancel the other queued slot; the granted lock lives until the body is consumed.
          waiting.abort()
          try {
            resolve(await operation())
          } catch (error) {
            reject(error)
          }
        })
        .catch(error => {
          if (claimed) return
          claimed = true
          waiting.abort()
          reject(error)
        })
    }
  })
}

export function executorRequestPriority(
  method: string,
  params: Record<string, unknown>
): DshRequestPriority {
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
