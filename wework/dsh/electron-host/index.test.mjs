import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { ElectronHostClient, ElectronHostError } from './electron-host-client.js'
import { apply, completeStartupCpuProfile, hostDisconnectHandler } from './index.js'

for (const [profiling, capability, failed] of [
  [false, 'rendererStorage.initialize', false],
  [true, 'preferences.get', false],
  [true, 'rendererStorage.initialize', false],
  [true, 'rendererStorage.initialize', true],
]) {
  test(`traces only profiled storage HTTP stages: ${profiling}/${capability}/${failed}`, async () => {
    const originalFactory = ElectronHostClient.fromEnvironment
    const originalProfile = process.env.WEWORK_E2E_CORE_CPU_PROFILE
    const originalManaged = process.env.WEWORK_DSH_MANAGED_ENDPOINT
    const originalInfo = console.info
    const markers = []
    let handler
    let resolveHost
    let rejectHost
    const hostResponse = new Promise((resolve, reject) => {
      resolveHost = resolve
      rejectHost = reject
    })
    ElectronHostClient.fromEnvironment = () => ({
      start: async () => {},
      invoke: () => hostResponse,
    })
    process.env.WEWORK_E2E_CORE_CPU_PROFILE = profiling ? '1' : '0'
    process.env.WEWORK_DSH_MANAGED_ENDPOINT = '0'
    console.info = (prefix, marker) => markers.push({ prefix, ...marker })
    try {
      await apply({
        get: () => () => {},
        reflect: { provide: () => () => {} },
        effect: callback => callback(),
        webServer: {
          register: route => {
            if (route.path.endsWith('/invoke')) handler = route.handler
            return () => {}
          },
        },
      })
      const req = Readable.from([
        JSON.stringify({ capability, params: { entries: { private: 'private-value' } } }),
      ])
      Object.assign(req, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      let responseStatus
      let responseBody
      let phasesAtEnd
      const request = handler(req, {
        writeHead: status => {
          responseStatus = status
        },
        end: body => {
          responseBody = JSON.parse(body)
          phasesAtEnd = markers.map(({ phase }) => phase)
        },
      })
      await new Promise(resolve => setImmediate(resolve))
      const traced = profiling && capability === 'rendererStorage.initialize'
      assert.deepEqual(
        markers.map(({ phase }) => phase),
        traced ? ['request-body-parsed'] : []
      )
      if (failed) rejectHost(new ElectronHostError('storage_unavailable', 'private-error'))
      else resolveHost({ private: 'private-result' })
      await request
      assert.equal(responseStatus, failed ? 500 : 200)
      assert.deepEqual(
        responseBody,
        failed
          ? {
              ok: false,
              error: { code: 'storage_unavailable', message: 'private-error', details: {} },
            }
          : { ok: true, result: { private: 'private-result' } }
      )
      assert.deepEqual(
        markers.map(({ phase }) => phase),
        traced
          ? [
              'request-body-parsed',
              ...(failed ? ['failed'] : ['host-response-received', 'http-response-ended']),
            ]
          : []
      )
      if (traced && !failed)
        assert.deepEqual(phasesAtEnd, ['request-body-parsed', 'host-response-received'])
      for (const marker of markers) {
        assert.deepEqual(Object.keys(marker).sort(), ['durationMs', 'phase', 'prefix'])
        assert.equal(marker.prefix, '[startup][core-host-storage]')
        assert.ok(marker.durationMs >= 0)
      }
      assert.equal(JSON.stringify(markers).includes('private'), false)
    } finally {
      ElectronHostClient.fromEnvironment = originalFactory
      console.info = originalInfo
      if (originalProfile === undefined) delete process.env.WEWORK_E2E_CORE_CPU_PROFILE
      else process.env.WEWORK_E2E_CORE_CPU_PROFILE = originalProfile
      if (originalManaged === undefined) delete process.env.WEWORK_DSH_MANAGED_ENDPOINT
      else process.env.WEWORK_DSH_MANAGED_ENDPOINT = originalManaged
    }
  })
}

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
          throw Object.assign(new Error('private-token/path'), {
            code,
            validationCode: 'private-validation/path',
          })
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
      assert.equal(JSON.stringify(result).includes('private-validation'), false)
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
