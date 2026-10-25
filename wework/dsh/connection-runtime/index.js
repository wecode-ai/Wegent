import { randomBytes } from 'node:crypto'
import { handleConnectionRpc } from './rpc.js'
import { installedProviders } from './installed-providers.js'
import { connectionTools } from '@wegent/dsh-plugin-runtime/connection-tools'
import { satisfies } from 'semver'
import { ExecutorRuntimeClient } from '@wegent/dsh-executor-runtime/client'
import {
  ConnectionRegistry,
  ConnectionError,
  parseConnections,
} from '@wegent/dsh-plugin-runtime/connections'
import { ConnectionDependencies } from '@wegent/dsh-plugin-runtime/connection-dependencies'

export const name = 'wework-connection-runtime'
export const inject = ['webServer']
export const BASE_PATH = '/wework/connections/v1/rpc'

export async function apply(ctx) {
  const client = ExecutorRuntimeClient.fromEnvironment()
  await client.start()
  const token = randomBytes(32).toString('hex')
  const dependencies = new ConnectionDependencies(
    (method, params) =>
      method === 'plugin/installed'
        ? client.request('runtime.connections.dependencies.inventory', {})
        : client.request('runtime.codex.app_server.request', { method, params }),
    satisfies
  )
  const registry = new ConnectionRegistry({
    inventory: () => dependencies.inventory(),
    satisfies,
    context: identity =>
      Object.freeze({
        ...identity,
        ...connectionTools(
          identity,
          dependencies,
          async (method, params) => {
            await publishHost()
            identity.signal.throwIfAborted()
            return client.request(method, params)
          },
          satisfies
        ),
      }),
  })
  let stopped = false
  let timer
  const publishHost = async () => {
    const port = ctx.webServer.port
    if (port)
      await client.request('runtime.connections.host', {
        url: `http://127.0.0.1:${port}${BASE_PATH}`,
        token,
        dependencyReferences: [...registry.entries.values()].flatMap(entry =>
          entry.provider.uses.map(alias => ({
            providerId: entry.id,
            alias,
            ...entry.definition.dependencies[alias].source,
            readTools: entry.provider.mcpReadTools?.[alias] ?? [],
            cliReadTools: entry.provider.cliReadTools?.[alias] ?? null,
          }))
        ),
      })
  }
  const heartbeat = async () => {
    try {
      await publishHost()
    } catch (error) {
      console.error('[wework-connections] host registration failed', {
        code: error.code ?? 'host_unavailable',
      })
    } finally {
      if (!stopped) timer = setTimeout(heartbeat, 5000)
    }
  }
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(
      'weworkConnections',
      Object.freeze({ register: registry.register.bind(registry) })
    )
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: BASE_PATH,
      handler: (req, res) =>
        handleConnectionRpc(req, res, token, async body => {
          if (body.method === 'catalog') {
            await publishHost()
            return {
              items: await installedProviders(
                process.env.DSH_HOME,
                await registry.catalog(),
                parseConnections
              ),
            }
          }
          if (body.method === 'installDependencies') {
            const entry = registry.entries.get(body.providerId)
            if (!entry)
              throw new ConnectionError('connection_unavailable', 'Connection is not active')
            return dependencies.install(entry.definition, body.input.aliases)
          }
          return registry.call(body.providerId, body.method, body.input ?? {})
        }),
    })
    void heartbeat()
    return () => {
      stopped = true
      clearTimeout(timer)
      registry.dispose()
      unregister()
      unprovide()
      void client.stop()
    }
  }, 'wework connections: runtime')
}
