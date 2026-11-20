const PROVIDERS = new Set([
  '@wegent/dsh-connection-git/github',
  '@wegent/dsh-connection-git/gitlab',
])
const INBOX_OPERATIONS = new Set(['events', 'ack', 'boundary'])

function denied() {
  return Object.assign(new Error('Git connection identity or operation is not allowed'), {
    code: 'connection_tool_denied',
  })
}

const GIT_READ_FIELDS = new Set([
  'accountId',
  'after',
  'entityKind',
  'instance',
  'jobId',
  'login',
  'number',
  'operation',
  'page',
  'path',
  'profile',
  'providerId',
  'query',
  'repository',
  'repositoryId',
  'sha',
])

// Overlapping selections can share native reads while retaining their own cursors.
function sharedReads(request) {
  const reads = new Map()
  return async (params, signal) => {
    signal.throwIfAborted()
    const input = Object.fromEntries(
      Object.entries(params)
        .filter(([field]) => GIT_READ_FIELDS.has(field))
        .sort(([a], [b]) => a.localeCompare(b))
    )
    const key = JSON.stringify(input)
    let read = reads.get(key)
    if (!read || read.controller.signal.aborted) {
      const controller = new AbortController()
      read = {
        controller,
        consumers: 0,
        result: Promise.resolve().then(() =>
          request('runtime.connections.git.read', input, { signal: controller.signal })
        ),
      }
      reads.set(key, read)
    }
    read.consumers++
    let abort
    try {
      const canceled = new Promise((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
      const result = await Promise.race([read.result, canceled])
      return structuredClone(result)
    } finally {
      signal.removeEventListener('abort', abort)
      if (--read.consumers === 0) {
        if (reads.get(key) === read) reads.delete(key)
        read.controller.abort()
      }
    }
  }
}

// The plugin owns its native Git adapter; the connection host stays source-agnostic.
export function bindGitProvider(providerId, provider, request, declaredAuthTarget) {
  if (!PROVIDERS.has(providerId)) throw denied()
  const sharedRead = sharedReads(request)
  return Object.fromEntries(
    Object.entries(provider).map(([name, operation]) => [
      name,
      async (context, input) => {
        if (context.providerId !== providerId) throw denied()
        context.signal.throwIfAborted()
        const call = async (method, params) => {
          context.signal.throwIfAborted()
          const result = await request(
            method,
            { ...params, providerId },
            { signal: context.signal }
          )
          context.signal.throwIfAborted()
          return result
        }
        const git = Object.freeze({
          read: params =>
            name === 'collect'
              ? sharedRead({ ...params, providerId }, context.signal)
              : call('runtime.connections.git.read', params),
          authTarget: async params => {
            context.signal.throwIfAborted()
            if (declaredAuthTarget) return structuredClone(declaredAuthTarget)
            if (
              providerId !== '@wegent/dsh-connection-git/gitlab' ||
              typeof params.instance !== 'string' ||
              !params.instance.trim()
            )
              throw denied()
            return call('runtime.connections.git.authTarget', { instance: params.instance })
          },
          inbox: params => {
            if (!INBOX_OPERATIONS.has(params.operation)) throw denied()
            return call('runtime.connections.git.webhooks', params)
          },
        })
        try {
          const result = await operation(Object.freeze({ ...context, git }), input)
          context.signal.throwIfAborted()
          return result
        } catch (error) {
          if (
            name === 'collect' &&
            [
              'git_cli_failed',
              'git_cli_timeout',
              'git_rate_limited',
              'cloud_unavailable',
              'cloud_request_failed',
            ].includes(error.code)
          )
            error.retryAfterMs ??= 30000
          throw error
        }
      },
    ])
  )
}
