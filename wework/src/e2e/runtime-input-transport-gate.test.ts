import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  armRuntimeInputTransportGate,
  readRuntimeInputTransportGate,
  releaseRuntimeInputTransportGate,
} from './runtime-input-transport-gate'

const url = '/wework/executor/v1/rpc'
const input = {
  method: 'POST',
  body: JSON.stringify({
    method: 'runtime.tasks.send',
    params: { taskId: 'isolated-task', requestUserInputResponse: { requestId: 1 } },
  }),
}
const state = () => JSON.parse(readRuntimeInputTransportGate())

beforeEach(() => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
})

afterEach(() => {
  releaseRuntimeInputTransportGate()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test('holds a real response after forwarding and preserves its body on release', async () => {
  const response = new Response(JSON.stringify({ ok: true, result: { accepted: true } }))
  const transport = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', transport)
  armRuntimeInputTransportGate('response')
  let delivered = false
  const pending = window.fetch(url, input).then(result => {
    delivered = true
    return result
  })
  await vi.waitFor(() => expect(state().held).toBe(true))
  expect(transport).toHaveBeenCalledWith(url, input)
  expect(state().accepted).toBe(true)
  expect(delivered).toBe(false)
  releaseRuntimeInputTransportGate()
  releaseRuntimeInputTransportGate()
  expect(await pending).toBe(response)
  expect(await response.json()).toEqual({ ok: true, result: { accepted: true } })
  expect(window.fetch).toBe(transport)
})

test('holds only the first input request and lets unrelated traffic progress', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })))
  vi.stubGlobal('fetch', transport)
  armRuntimeInputTransportGate('request')
  const pending = window.fetch(url, input)
  expect(state().held).toBe(true)
  expect(transport).not.toHaveBeenCalled()
  await window.fetch(url, input)
  await window.fetch('/wework/executor/v1/events')
  expect(transport).toHaveBeenCalledTimes(2)
  releaseRuntimeInputTransportGate()
  await pending
  expect(transport).toHaveBeenCalledTimes(3)
  expect(state().accepted).toBe(false)
})

test('cancellation releases a blocked request without forwarding it', async () => {
  const transport = vi.fn()
  vi.stubGlobal('fetch', transport)
  const controller = new AbortController()
  armRuntimeInputTransportGate('request')
  const pending = window.fetch(url, { ...input, signal: controller.signal })
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(state().released).toBe(true)
  expect(transport).not.toHaveBeenCalled()
})
