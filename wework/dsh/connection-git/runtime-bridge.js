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

// The plugin owns its native Git adapter; the connection host stays source-agnostic.
export function bindGitProvider(providerId, provider, request, declaredAuthTarget) {
  if (!PROVIDERS.has(providerId)) throw denied()
  return Object.fromEntries(
    Object.entries(provider).map(([name, operation]) => [
      name,
      async (context, input) => {
        if (context.providerId !== providerId) throw denied()
        context.signal.throwIfAborted()
        const call = async (method, params) => {
          context.signal.throwIfAborted()
          const result = await request(method, { ...params, providerId })
          context.signal.throwIfAborted()
          return result
        }
        const git = Object.freeze({
          read: params => call('runtime.connections.git.read', params),
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
