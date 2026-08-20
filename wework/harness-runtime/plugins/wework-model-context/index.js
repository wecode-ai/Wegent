import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'wework-model-context'
const inject = ['tools', 'web']
const endpoint = 'model'
const fetchProviderId = 'wework-loopback'

function registerLoopbackFetchProvider(ctx, config) {
  try {
    ctx.web.registerFetchProvider({
      id: fetchProviderId,
      available: () => true,
      async fetch(request, signal) {
        const url = new URL(request.url)
        const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : ''
        const base = baseUrl ? new URL(baseUrl) : null
        const basePath = base?.pathname.replace(/\/+$/, '')
        if (
          !base ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.origin !== base.origin ||
          !basePath ||
          (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
        ) {
          throw new Error('Wework context fetch is restricted to loopback')
        }
        const response = await globalThis.fetch(request.url, { signal })
        return {
          url: response.url,
          statusCode: response.status,
          body: { kind: 'text', content: await response.text() },
          truncated: false,
        }
      },
    })
  } catch (error) {
    if (error?.code !== 'WEB_DUPLICATE_PROVIDER') throw error
  }
}

function contextUrl(config) {
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : ''
  if (!baseUrl) throw new Error('Wework model context is unavailable')
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint}`
}

async function fetchContext(ctx, config, signal) {
  const result = await ctx.web.fetch({ url: contextUrl(config) }, signal)
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error('Wework model context is unavailable')
  }
  if (result.body.kind !== 'text' && result.body.kind !== 'html') {
    throw new Error('Wework model context response is unsupported')
  }
  return JSON.parse(result.body.content)
}

function apply(ctx, config) {
  registerLoopbackFetchProvider(ctx, config)
  ctx.tools.register(
    defineTool({
      name: 'get_current_model',
      description: 'Get the Wework model bound to this Smart app session.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runtimeModelId: { type: 'string', required: true },
            displayName: { type: 'string', required: true },
            modelType: { type: 'string', required: true },
            namespace: { type: 'string' },
            contextWindow: { type: 'integer' },
            maxOutputTokens: { type: 'integer' },
            capabilities: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(_args, exec) {
        return fetchContext(ctx, config, exec.signal)
      },
    })
  )
}

export { apply, endpoint, fetchContext, fetchProviderId, inject, name }
