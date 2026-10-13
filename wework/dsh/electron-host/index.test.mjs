import assert from 'node:assert/strict'
import test from 'node:test'
import { ElectronHostClient } from './electron-host-client.js'
import { apply, completeStartupCpuProfile, hostDisconnectHandler } from './index.js'

test('requests bounded DSH exit when the Electron host disconnects', () => {
  const exits = []
  const disconnect = hostDisconnectHandler({
    get(name) {
      assert.equal(name, 'appExit')
      return code => exits.push(code)
    },
  })

  disconnect()

  assert.deepEqual(exits, [0])
})

test('requires the launcher exit service', () => {
  assert.throws(
    () => hostDisconnectHandler({ get: () => undefined }),
    /requires the DSH launcher appExit service/
  )
})

for (const profiling of [false, true])
  test(`publishes the managed endpoint with diagnostic mode ${profiling}`, async () => {
    const key = Symbol.for('wework.core.startupCpuProfiler')
    const originalProfiler = globalThis[key]
    const originalFactory = ElectronHostClient.fromEnvironment
    const originalManaged = process.env.WEWORK_DSH_MANAGED_ENDPOINT
    const originalDiagnostic = process.env.WEWORK_E2E_CORE_CPU_PROFILE
    const originalLog = console.info
    const events = []
    let profilerCalls = 0
    let finishSummary
    let endpointCallback
    const summary = new Promise(resolve => {
      finishSummary = resolve
    })
    globalThis[key] = {
      complete: () => {
        profilerCalls += 1
        return summary
      },
    }
    process.env.WEWORK_DSH_MANAGED_ENDPOINT = '1'
    process.env.WEWORK_E2E_CORE_CPU_PROFILE = profiling ? '1' : '0'
    ElectronHostClient.fromEnvironment = () => ({
      start: async () => {},
      stop() {},
      reportRuntimeEndpoint: () => events.push('endpoint'),
    })
    console.info = (prefix, marker) => {
      assert.equal(prefix, '[startup][core-dsh-endpoint]')
      assert.equal(marker.cpuProfileSummaryMode, profiling ? 'before-endpoint' : undefined)
      events.push('marker')
    }
    try {
      await apply({
        get: () => () => {},
        inject: (_dependencies, callback) => {
          endpointCallback = callback
        },
        effect: () => {},
      })
      const publication = endpointCallback({
        webServer: { port: 3080 },
        connection: { authenticatedUrl: url => url },
      })
      await Promise.resolve()
      assert.deepEqual(events, profiling ? [] : ['marker', 'endpoint'])
      assert.equal(profilerCalls, profiling ? 1 : 0)
      if (!profiling) assert.equal(publication, undefined)
      finishSummary({
        cpuProfileSummaryMode: 'before-endpoint',
        cpuProfileProcessId: process.pid,
        cpuProfileEndTimeUs: 1234,
      })
      await publication
      assert.deepEqual(events, ['marker', 'endpoint'])
    } finally {
      globalThis[key] = originalProfiler
      ElectronHostClient.fromEnvironment = originalFactory
      console.info = originalLog
      if (originalManaged === undefined) delete process.env.WEWORK_DSH_MANAGED_ENDPOINT
      else process.env.WEWORK_DSH_MANAGED_ENDPOINT = originalManaged
      if (originalDiagnostic === undefined) delete process.env.WEWORK_E2E_CORE_CPU_PROFILE
      else process.env.WEWORK_E2E_CORE_CPU_PROFILE = originalDiagnostic
    }
  })

test('reports only fixed CPU diagnostic failure categories', async () => {
  const key = Symbol.for('wework.core.startupCpuProfiler')
  const original = globalThis[key]
  try {
    for (const code of [
      'core_profile_stop_failed',
      'core_profile_summarize_failed',
      'core_profile_write_failed',
      'private-token/path',
    ]) {
      globalThis[key] = {
        complete: async () => {
          throw Object.assign(new Error('private-token/path'), { code })
        },
      }
      const result = await completeStartupCpuProfile()
      assert.equal(result.cpuProfileClockStatus, 'failed')
      assert.equal(result.cpuProfileSummaryMode, 'before-endpoint')
      assert.equal(
        result.cpuProfileFailureCode,
        code === 'private-token/path' ? 'core_profile_unknown_failure' : code
      )
      assert.equal(JSON.stringify(result).includes('private-token'), false)
    }
    delete globalThis[key]
    assert.equal(
      (await completeStartupCpuProfile()).cpuProfileFailureCode,
      'core_profile_unavailable'
    )
  } finally {
    globalThis[key] = original
  }
})
