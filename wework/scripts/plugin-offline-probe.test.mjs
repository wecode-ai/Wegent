import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertOfflinePluginCodexStayedStopped,
  offlinePluginProcesses,
  readCodexStartCount,
  stopCodexForOfflinePluginProbe,
  waitForOfflinePluginSetupSockets,
} from '../e2e/desktop/modules/plugin-offline-probe.mjs'

function fixture(t, options = {}) {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const executor = {
    id: '11:executor',
    pid: 11,
    startedAt: now - 1000,
    owner: { id: 'executor' },
    kind: 'host-service',
    name: 'Executor',
  }
  const server = {
    id: `22:${now - 500}`,
    pid: 22,
    parentPid: 11,
    startedAt: now - 500,
    owner: { id: 'executor' },
    kind: 'host-child',
    name: 'codex',
    detail: '/isolated/codex app-server --listen stdio://',
  }
  const state = { alive: true, reads: 0, waits: 0, signals: [], calls: [] }
  const snapshot = () => {
    now += 1
    const value = {
      capturedAt: now,
      platform: process.platform,
      degraded: [],
      collectingSystemProcesses: false,
      processes: [executor, ...(state.alive ? [server] : [])],
    }
    state.reads += 1
    return options.snapshot?.(value, state.reads) ?? value
  }
  const control = {
    async command(action) {
      state.calls.push(action)
      if (action === 'restartLocalCodexAppServerIfIdle')
        return JSON.stringify(
          options.idle ?? {
            restarted: true,
            requiresConfirmation: false,
            activeTaskCount: 0,
            pendingRequestCount: 0,
          }
        )
      if (action === 'getDesktopRuntimeDiagnostics') return JSON.stringify({ executorPid: 11 })
      assert.equal(action, 'getOwnedProcessSnapshot')
      return JSON.stringify(snapshot())
    },
  }
  const dependencies = {
    signal(pid, signal) {
      state.signals.push({ pid, signal })
    },
    isAlive() {
      if (state.waits >= (options.exitAfterWaits ?? 0)) state.alive = false
      return state.alive
    },
    async wait(ms) {
      now += ms
      state.waits += 1
    },
  }
  return { control, dependencies, state, snapshot }
}

test('stops only the verified idle Codex child and waits for exit before establishing the barrier', async t => {
  const { control, dependencies, state } = fixture(t, { exitAfterWaits: 2 })
  const evidence = await stopCodexForOfflinePluginProbe(control, dependencies)
  assert.deepEqual(state.signals, [{ pid: 22, signal: 'SIGTERM' }])
  assert.equal(state.waits, 2)
  assert.equal(evidence.stopped[0].pid, 22)
  assert.ok(evidence.snapshotCapturedAt > evidence.stoppedAt)
  assert.equal(state.reads, 3)
  await assertOfflinePluginCodexStayedStopped(control, evidence)
})

test('rejects active work before looking up or signalling a process', async t => {
  const { control, dependencies, state } = fixture(t, {
    idle: { restarted: false, requiresConfirmation: true, activeTaskCount: 1 },
  })
  await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies), /idle Codex process/)
  assert.deepEqual(state.calls, ['restartLocalCodexAppServerIfIdle'])
  assert.deepEqual(state.signals, [])
})

for (const change of ['owner', 'parent', 'creation', 'executor']) {
  test(`refuses to signal after the ${change} identity changes`, async t => {
    const { control, dependencies, state } = fixture(t, {
      snapshot(value, read) {
        if (read !== 2) return value
        const processes = value.processes.map(record => structuredClone(record))
        if (change === 'owner') processes[1].owner.id = 'another-runtime'
        if (change === 'parent') processes[1].parentPid = 99
        if (change === 'creation') processes[1].startedAt += 1
        if (change === 'executor') processes[0].startedAt += 1
        return { ...value, processes }
      },
    })
    await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies))
    assert.deepEqual(state.signals, [])
  })
}

test('requires a new process-table capture before revalidating a PID', async t => {
  let firstCapture
  const { control, dependencies, state } = fixture(t, {
    snapshot(value, read) {
      if (read === 1) firstCapture = value.capturedAt
      return read === 2 ? { ...value, capturedAt: firstCapture } : value
    },
  })
  await stopCodexForOfflinePluginProbe(control, dependencies)
  assert.equal(state.reads, 4)
  assert.equal(state.waits, 1)
  assert.deepEqual(state.signals, [{ pid: 22, signal: 'SIGTERM' }])
})

test('waits for the system table to finish collecting before selecting a process', async t => {
  const { control, dependencies, state } = fixture(t, {
    snapshot(value, read) {
      return read === 1 ? { ...value, collectingSystemProcesses: true, processes: [] } : value
    },
  })
  await stopCodexForOfflinePluginProbe(control, dependencies)
  assert.equal(state.waits, 1)
  assert.deepEqual(state.signals, [{ pid: 22, signal: 'SIGTERM' }])
})

test('fails a stop timeout without escalating to a forced kill', async t => {
  const { control, dependencies, state } = fixture(t, { exitAfterWaits: Infinity })
  await assert.rejects(
    stopCodexForOfflinePluginProbe(control, { ...dependencies, timeoutMs: 25 }),
    /did not exit after SIGTERM/
  )
  assert.deepEqual(state.signals, [{ pid: 22, signal: 'SIGTERM' }])
})

test('detects an app-server restarted by the measured local operations', async t => {
  const { control, dependencies, state } = fixture(t)
  const evidence = await stopCodexForOfflinePluginProbe(control, dependencies)
  state.alive = true
  await assert.rejects(
    assertOfflinePluginCodexStayedStopped(control, evidence),
    /Local plugin import or deletion started Codex/
  )
})

test('rejects incomplete process snapshots instead of treating them as an absent app-server', t => {
  const { snapshot } = fixture(t)
  assert.throws(
    () =>
      offlinePluginProcesses(
        { ...snapshot(), degraded: [{ code: 'system-process-table-failed' }] },
        11
      ),
    /incomplete/
  )
})

test('drains both live sockets and accepted connections using their actual close state', async () => {
  const socket = {}
  const connection = { connectionId: 1, acceptedAt: Date.now() }
  const proxy = { released: true, sockets: new Set([socket]), connections: [connection] }
  let waits = 0
  await waitForOfflinePluginSetupSockets(proxy, {
    async wait() {
      waits += 1
      if (waits === 1) proxy.sockets.delete(socket)
      if (waits === 2) connection.closedAt = Date.now()
    },
  })
  assert.equal(waits, 2)
})

test('refuses to measure while a setup socket remains open', async () => {
  const proxy = {
    released: true,
    sockets: new Set([{}]),
    connections: [{ connectionId: 1, acceptedAt: Date.now() }],
  }
  await assert.rejects(waitForOfflinePluginSetupSockets(proxy, { timeoutMs: 0 }), /did not close/)
})

test('counts app-server starts even when the child exited before the final snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-offline-probe-'))
  const path = join(directory, 'executor.log')
  try {
    await writeFile(path, 'codex shared app-server process starting process_id=22\n')
    assert.equal(await readCodexStartCount(path), 1)
    await writeFile(path, 'codex shared app-server process starting process_id=23\n', { flag: 'a' })
    assert.equal(await readCodexStartCount(path), 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
