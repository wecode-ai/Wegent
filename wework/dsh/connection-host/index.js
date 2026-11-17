import { randomBytes } from 'node:crypto'
import { handleConnectionRpc } from './rpc.js'
import { installedProviders } from './installed-providers.js'
import { createConnectionRuntime } from '@wegent/dsh-plugin-runtime/connection-runtime'
import {
  collectObservation,
  initializeObservation,
} from '@wegent/dsh-plugin-runtime/connection-observations'
import {
  cloudObservationClient,
  runCloudObservation,
} from '@wegent/dsh-plugin-runtime/cloud-observations'
import { satisfies } from 'semver'
import { ExecutorRuntimeClient } from '@wegent/dsh-executor-runtime/client'
import { ConnectionError, parseConnections } from '@wegent/dsh-plugin-runtime/connections'
import { ConnectionDependencies } from '@wegent/dsh-plugin-runtime/connection-dependencies'

export const name = 'wework-connection-host'
export const inject = ['webServer', 'profileContext']
export const BASE_PATH = '/wework/connections/v1/rpc'

export async function apply(ctx) {
  const configuredOwner = process.env.WEWORK_CONNECTION_OWNER_ID
  const boundOwner = configuredOwner === undefined ? undefined : Number(configuredOwner)
  if (boundOwner !== undefined && (!Number.isSafeInteger(boundOwner) || boundOwner <= 0))
    throw new ConnectionError('observation_owner_required', 'Connection service owner is invalid')
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
  const runtime = createConnectionRuntime({
    dependencies,
    request: (method, params, options) =>
      client.request(method, params, undefined, undefined, options),
    satisfies,
    beforeRequest: () => publishHost(),
  })
  const { registry } = runtime
  let stopped = false
  let timer
  const publishHost = async () => {
    const port = ctx.webServer.port
    if (port)
      await client.request('runtime.connections.host', {
        url: `http://127.0.0.1:${port}${BASE_PATH}`,
        token,
        ...runtime.registration(),
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
                ctx.profileContext.dir,
                await registry.catalog(),
                parseConnections
              ),
            }
          }
          if (['planDependencyInstallation', 'dependencyPlan'].includes(body.method)) {
            await publishHost()
            const entry = registry.entries.get(body.providerId)
            if (!entry)
              throw new ConnectionError('connection_unavailable', 'Connection is not active')
            return body.method === 'dependencyPlan'
              ? dependencies.plan(entry.definition)
              : dependencies.installationPlan(
                  entry.definition,
                  body.input.aliases,
                  body.input.catalog
                )
          }
          if (body.method === 'initializeObservation')
            return initializeObservation(registry, body.providerId, body.input)
          if (body.method === 'collectCloudObservation') {
            if (
              !Number.isSafeInteger(body.input?.expectedOwnerId) ||
              body.input.expectedOwnerId <= 0
            )
              throw new ConnectionError(
                'observation_owner_required',
                'Observation account is required'
              )
            if (boundOwner !== undefined && body.input.expectedOwnerId !== boundOwner)
              throw new ConnectionError(
                'observation_owner_changed',
                'Connection service belongs to another account'
              )
            return runCloudObservation(
              registry,
              cloudObservationClient(body.input.backendUrl, body.input.collectorToken),
              { expectedOwnerId: body.input.expectedOwnerId }
            )
          }
          return body.method === 'collectObservation'
            ? collectObservation(registry, body.providerId, body.input ?? {})
            : registry.call(body.providerId, body.method, body.input ?? {})
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
