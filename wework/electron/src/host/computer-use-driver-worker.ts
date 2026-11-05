import { CuaDriver } from '@trycua/cua-driver'
import type { DriverRequest, DriverResponse } from './computer-use-driver-protocol.js'

const port = process.parentPort
if (!port) throw new Error('Computer use driver requires a parent process')

let driver: (ReturnType<typeof CuaDriver.create> & { uniffiDestroy?: () => void }) | null = null
const actions = new Map<number, AbortController>()

port.on('message', ({ data }: { data: DriverRequest }) => {
  if (data.method === 'abort') {
    actions.get(data.id)?.abort()
    return
  }
  void handleRequest(data).then(
    result => port.postMessage({ id: data.id, ok: true, result } satisfies DriverResponse),
    error =>
      port.postMessage({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies DriverResponse)
  )
})

async function handleRequest(request: Exclude<DriverRequest, { method: 'abort' }>) {
  if (request.method === 'start') {
    driver = CuaDriver.create(undefined)
    return
  }
  if (!driver) throw new Error('Computer use driver is not running')
  if (request.method === 'listTools') return driver.listToolsJson()
  if (request.method === 'shutdown') {
    for (const controller of actions.values()) controller.abort()
    await driver.shutdown()
    driver.uniffiDestroy?.()
    driver = null
    return
  }
  const controller = new AbortController()
  actions.set(request.id, controller)
  try {
    return await driver.callTool(request.name, request.argumentsJson, { signal: controller.signal })
  } finally {
    actions.delete(request.id)
  }
}
