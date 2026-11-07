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
  const state = {
    alive: options.serverPresent !== false,
    reads: 0,
    identityReads: {},
    waits: 0,
    signals: [],
    calls: [],
  }
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
    async collectIdentity(pid) {
      state.identityReads[pid] = (state.identityReads[pid] ?? 0) + 1
      const identity = { pid, creationToken: `native:${pid}:original` }
      return options.identity
        ? options.identity(identity, state.identityReads[pid], state)
        : identity
    },
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
  await assertOfflinePluginCodexStayedStopped(control, evidence, dependencies)
})

test('proves the Executor identity when idle admission has already stopped Codex', async t => {
  const { control, dependencies, state } = fixture(t, { serverPresent: false })
  const evidence = await stopCodexForOfflinePluginProbe(control, dependencies)
  await assertOfflinePluginCodexStayedStopped(control, evidence, dependencies)
  assert.deepEqual(evidence.stopped, [])
  assert.deepEqual(state.signals, [])
  assert.equal(state.identityReads[11], 3)
  assert.equal(state.identityReads[22], undefined)
})

test('rejects active work before looking up or signalling a process', async t => {
  const { control, dependencies, state } = fixture(t, {
    idle: { restarted: false, requiresConfirmation: true, activeTaskCount: 1 },
  })
  await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies), /idle Codex process/)
  assert.deepEqual(state.calls, ['restartLocalCodexAppServerIfIdle'])
  assert.deepEqual(state.signals, [])
})

for (const change of ['owner', 'parent']) {
  test(`refuses to signal after the ${change} identity changes`, async t => {
    const { control, dependencies, state } = fixture(t, {
      snapshot(value, read) {
        if (read !== 2) return value
        const processes = value.processes.map(record => structuredClone(record))
        if (change === 'owner') processes[1].owner.id = 'another-runtime'
        if (change === 'parent') processes[1].parentPid = 99
        return { ...value, processes }
      },
    })
    await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies))
    assert.deepEqual(state.signals, [])
  })
}

for (const pid of [11, 22]) {
  test(`refuses to signal when PID ${pid} has a different native creation token`, async t => {
    const { control, dependencies, state } = fixture(t, {
      identity(value, read) {
        return value.pid === pid && read === 2
          ? { ...value, creationToken: `${value.creationToken}:replacement` }
          : value
      },
    })
    await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies))
    assert.deepEqual(state.signals, [])
  })
}

test('keeps exact native identity when display creation estimates and IDs drift between snapshots', async t => {
  const { control, dependencies, state } = fixture(t, {
    snapshot(value, read) {
      return {
        ...value,
        processes: value.processes.map(record => ({
          ...record,
          startedAt: record.startedAt - read * 1000,
          id: `${record.pid}:sample-${read}`,
        })),
      }
    },
  })
  const evidence = await stopCodexForOfflinePluginProbe(control, dependencies)
  await assertOfflinePluginCodexStayedStopped(control, evidence, dependencies)
  assert.deepEqual(state.signals, [{ pid: 22, signal: 'SIGTERM' }])
  assert.equal(evidence.executor.creationToken, 'native:11:original')
})

test('refuses to signal if the owned process disappears before native identity collection', async t => {
  const { control, dependencies, state } = fixture(t, {
    identity(value) {
      return value.pid === 22 ? null : value
    },
  })
  await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies), /exited before/)
  assert.deepEqual(state.signals, [])
})

test('detects PID reuse while waiting for exit without signalling the replacement process', async t => {
  const { control, dependencies, state } = fixture(t, {
    exitAfterWaits: Infinity,
    identity(value, read) {
      return value.pid === 22 && read >= 3
        ? { ...value, creationToken: 'native:22:replacement' }
        : value
    },
  })
  await assert.rejects(stopCodexForOfflinePluginProbe(control, dependencies), /PID was reused/)
  assert.deepEqual(state.signals, [{ pid: 22, signal: 'SIGTERM' }])
})

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
    assertOfflinePluginCodexStayedStopped(control, evidence, dependencies),
    /Local plugin import or deletion started Codex/
  )
})

test('rejects a replacement Executor after local operations using its native creation token', async t => {
  const { control, dependencies } = fixture(t, {
    identity(value, read) {
      return value.pid === 11 && read >= 4
        ? { ...value, creationToken: 'native:11:replacement' }
        : value
    },
  })
  const evidence = await stopCodexForOfflinePluginProbe(control, dependencies)
  await assert.rejects(
    assertOfflinePluginCodexStayedStopped(control, evidence, dependencies),
    /isolated Executor changed/
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
