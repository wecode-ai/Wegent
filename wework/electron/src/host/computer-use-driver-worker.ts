import { CuaDriver } from '@trycua/cua-driver'
import {
  isDriverRequest,
  type DriverRequest,
  type DriverResponse,
} from './computer-use-driver-protocol.js'

if (!process.send) throw new Error('Computer use driver requires a parent IPC channel')
const send = process.send.bind(process)

let driver: (ReturnType<typeof CuaDriver.create> & { uniffiDestroy?: () => void }) | null = null
let readOnlyTools = new Set<string>()
const actions = new Map<number, { controller: AbortController; cancellable: boolean }>()

process.once('disconnect', () => process.exit(0))
process.on('message', (data: unknown) => {
  if (!isDriverRequest(data)) return
  if (data.method === 'abort') {
    const action = actions.get(data.id)
    if (action?.cancellable) action.controller.abort()
    return
  }
  void handleRequest(data).then(
    result => respond({ id: data.id, ok: true, result }),
    error =>
      respond({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
  )
})

/** Stop immediately when replies can no longer reach the owning host. */
function respond(response: DriverResponse): void {
  send(response, error => {
    if (error) process.exit(1)
  })
}

/** Keep cancellation controllers in the process that owns their native calls. */
async function handleRequest(request: Exclude<DriverRequest, { method: 'abort' }>) {
  if (request.method === 'start') {
    driver = CuaDriver.create(undefined)
    const catalog = JSON.parse(await driver.listToolsJson()) as {
      tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
    }
    if (!Array.isArray(catalog.tools)) throw new Error('CUA tool catalog is invalid')
    readOnlyTools = new Set(
      catalog.tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name)
    )
    return
  }
  if (!driver) throw new Error('Computer use driver is not running')
  if (request.method === 'shutdown') {
    for (const action of actions.values()) {
      if (action.cancellable) action.controller.abort()
    }
    await driver.shutdown()
    driver.uniffiDestroy?.()
    driver = null
    return
  }
  const controller = new AbortController()
  // Dropping a mutating Rust future can leave spawn_blocking input running and
  // skip native release cleanup. Keep its RPC pending until it actually settles;
  // the parent terminates this generation if the cancellation deadline expires.
  actions.set(request.id, {
    controller,
    cancellable: request.method === 'listTools' || readOnlyTools.has(request.name),
  })
  try {
    if (request.method === 'listTools')
      return await driver.listToolsJson({ signal: controller.signal })
    return await driver.callTool(request.name, request.argumentsJson, { signal: controller.signal })
  } finally {
    actions.delete(request.id)
  }
}
