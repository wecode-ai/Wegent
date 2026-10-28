import { ElectronHostClient } from './electron-host-client.js'
import { createWeworkDesktopService, WEWORK_DESKTOP_SERVICE_KEY } from './desktop-service.js'

export const name = 'wework-electron-host'
export const inject = ['webServer']

const BASE_PATH = '/wework/electron-host/v1'

export async function apply(ctx) {
  const client = ElectronHostClient.fromEnvironment(process.env, {
    onDisconnect: hostDisconnectHandler(ctx),
  })
  await client.start()
  const generation = createWeworkDesktopService(client)
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(WEWORK_DESKTOP_SERVICE_KEY, generation.service)
    return () => {
      unprovide()
      generation.dispose()
      client.stop()
    }
  }, 'wework-electron-host: desktop service generation')
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: BASE_PATH,
        handler: (req, res) => describe(req, res, client),
      }),
    `wework-electron-host: ${BASE_PATH}`
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE_PATH}/invoke`,
        handler: (req, res) => invoke(req, res, client),
      }),
    `wework-electron-host: ${BASE_PATH}/invoke`
  )
}

export function hostDisconnectHandler(ctx) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') {
    throw new Error('wework-electron-host requires the DSH launcher appExit service')
  }
  return () => exit(0)
}

// HTTP is not a desktop identity boundary. Even same-origin requests and
// requests without Origin must not reach Host capabilities.
export function describe(_req, res) {
  forbidden(res)
}

export function invoke(_req, res) {
  forbidden(res)
}

function forbidden(res) {
  const body = JSON.stringify({
    ok: false,
    error: { code: 'capability_denied', message: 'Use trusted desktop IPC' },
  })
  res.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
