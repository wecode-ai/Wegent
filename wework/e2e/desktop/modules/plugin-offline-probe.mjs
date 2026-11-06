import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { logDesktopE2eSignal, processIsAlive } from '../process-lifecycle.mjs'
import { collectProcessInstanceIdentity } from '../process-instance.mjs'

const STOP_TIMEOUT_MS = 10_000
const isAppServer = record => /(?:^|\s)app-server(?:\s|$)/.test(record.detail ?? '')

function snapshotProcess(record) {
  assert.ok(Number.isSafeInteger(record?.pid) && record.pid > 0, 'Invalid process PID')
  assert.ok(
    Number.isFinite(record.startedAt) && record.startedAt > 0 && record.startedAt <= Date.now(),
    'The offline probe requires a process creation time'
  )
  assert.ok(typeof record.id === 'string' && record.id.startsWith(`${record.pid}:`))
  return { snapshotId: record.id, pid: record.pid, sampledStartedAt: record.startedAt }
}

function processIdentity(record) {
  assert.ok(Number.isSafeInteger(record?.pid) && record.pid > 0, 'Invalid process PID')
  assert.ok(
    typeof record.creationToken === 'string' && record.creationToken.length > 0,
    'The offline probe requires an OS process creation token'
  )
  return { pid: record.pid, creationToken: record.creationToken }
}

export function offlinePluginProcesses(snapshot, executorPid) {
  assert.ok(Number.isSafeInteger(executorPid) && executorPid > 0, 'Missing isolated Executor PID')
  assert.ok(
    Number.isFinite(snapshot?.capturedAt) &&
      snapshot.capturedAt <= Date.now() &&
      Date.now() - snapshot.capturedAt <= STOP_TIMEOUT_MS,
    'The offline probe requires a fresh owned process snapshot'
  )
  assert.deepEqual(snapshot.degraded, [], 'The owned process snapshot is incomplete')
  assert.equal(snapshot.collectingSystemProcesses, false, 'The process table is still loading')
  assert.equal(snapshot.platform, process.platform)
  assert.ok(Array.isArray(snapshot.processes))
  assert.equal(
    new Set(snapshot.processes.map(record => record.pid)).size,
    snapshot.processes.length
  )
  const executor = snapshot.processes.find(record => record.pid === executorPid)
  assert.equal(executor?.owner?.id, 'executor', 'The PID is not the isolated Executor')
  assert.equal(executor.kind, 'host-service')
  const servers = snapshot.processes.filter(isAppServer)
  assert.ok(servers.length <= 1, 'The offline probe requires one isolated shared Codex process')
  for (const server of servers) {
    assert.match(server.name, /^codex(?:\.exe)?$/i, 'The app-server executable is not identified')
    assert.equal(server.owner?.id, 'executor', 'Refusing to stop a Codex process outside Executor')
    assert.equal(server.parentPid, executorPid, 'Refusing to stop a non-child Codex process')
    snapshotProcess(server)
  }
  return {
    capturedAt: snapshot.capturedAt,
    executor: snapshotProcess(executor),
    servers: servers.map(snapshotProcess),
  }
}

async function ownedProcesses(control, executorPid, after, { wait, timeoutMs, collectIdentity }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
    assert.deepEqual(snapshot.degraded, [], 'The owned process snapshot is incomplete')
    if (!snapshot.collectingSystemProcesses && snapshot.capturedAt > after) {
      const owned = offlinePluginProcesses(snapshot, executorPid)
      const bindIdentity = async record => {
        const identity = await collectIdentity(record.pid)
        assert.ok(identity, `Owned process ${record.pid} exited before its identity was read`)
        assert.equal(identity.pid, record.pid, 'The OS process identity has a different PID')
        return { ...record, ...processIdentity(identity) }
      }
      return {
        capturedAt: owned.capturedAt,
        executor: await bindIdentity(owned.executor),
        servers: await Promise.all(owned.servers.map(bindIdentity)),
      }
    }
    assert.ok(Date.now() < deadline, 'The owned process snapshot did not refresh')
    await wait(25)
  }
}

function assertSameExecutor(expected, actual) {
  assert.deepEqual(
    processIdentity(actual.executor),
    processIdentity(expected.executor),
    'The isolated Executor changed during the probe'
  )
}

export async function stopCodexForOfflinePluginProbe(
  control,
  {
    signal = process.kill,
    isAlive = processIsAlive,
    collectIdentity = collectProcessInstanceIdentity,
    wait = delay,
    timeoutMs = STOP_TIMEOUT_MS,
  } = {}
) {
  const idle = JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body'))
  assert.equal(idle.restarted, true, 'The offline probe could not acquire an idle Codex process')
  assert.equal(idle.requiresConfirmation, false, 'The offline probe must not interrupt active work')
  assert.equal(idle.activeTaskCount, 0)
  assert.equal(idle.pendingRequestCount, 0)
  const admittedAt = Date.now()
  const { executorPid } = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
  const sampling = { wait, timeoutMs, collectIdentity }
  const before = await ownedProcesses(control, executorPid, admittedAt, sampling)
  let lastCapturedAt = before.capturedAt
  for (const server of before.servers) {
    // Revalidate native creation identity and ownership before signalling a bare PID.
    const current = await ownedProcesses(control, executorPid, lastCapturedAt, sampling)
    lastCapturedAt = current.capturedAt
    assertSameExecutor(before, current)
    assert.deepEqual(
      processIdentity(current.servers.find(record => record.pid === server.pid)),
      processIdentity(server),
      'The Codex process identity changed before the offline probe could stop it'
    )
    logDesktopE2eSignal({ action: 'offline-plugin-stop-codex', ...server, signal: 'SIGTERM' })
    try {
      signal(server.pid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
    const deadline = Date.now() + timeoutMs
    while (isAlive(server.pid)) {
      const identity = await collectIdentity(server.pid)
      if (identity === null) break
      assert.deepEqual(
        processIdentity(identity),
        processIdentity(server),
        'The Codex PID was reused while waiting for the original process to exit'
      )
      assert.ok(Date.now() < deadline, 'The idle Codex process did not exit after SIGTERM')
      await wait(25)
    }
  }
  const stoppedAt = Date.now()
  const after = await ownedProcesses(control, executorPid, stoppedAt, sampling)
  assertSameExecutor(before, after)
  assert.deepEqual(after.servers, [], 'Codex restarted before the offline probe could begin')
  return {
    executor: before.executor,
    stopped: before.servers,
    admittedAt,
    stoppedAt,
    snapshotCapturedAt: after.capturedAt,
  }
}

export async function assertOfflinePluginCodexStayedStopped(
  control,
  evidence,
  {
    wait = delay,
    timeoutMs = STOP_TIMEOUT_MS,
    collectIdentity = collectProcessInstanceIdentity,
  } = {}
) {
  const operationsCompletedAt = Date.now()
  const after = await ownedProcesses(
    control,
    evidence.executor.pid,
    Math.max(evidence.snapshotCapturedAt, operationsCompletedAt),
    { wait, timeoutMs, collectIdentity }
  )
  assertSameExecutor(evidence, after)
  assert.deepEqual(after.servers, [], 'Local plugin import or deletion started Codex app-server')
  return { checkedAt: Date.now(), executor: after.executor }
}

export async function readCodexStartCount(logPath) {
  const log = await readFile(logPath, 'utf8')
  return [...log.matchAll(/codex shared app-server process starting process_id=\d+/g)].length
}

export async function waitForOfflinePluginSetupSockets(
  proxy,
  { wait = delay, timeoutMs = STOP_TIMEOUT_MS } = {}
) {
  assert.equal(proxy.released, true, 'Offline plugin setup must release the proxy before draining')
  const deadline = Date.now() + timeoutMs
  while (proxy.sockets.size > 0 || proxy.connections.some(connection => !connection.closedAt)) {
    assert.ok(Date.now() < deadline, 'The offline plugin setup connections did not close')
    await wait(25)
  }
  return { closedAt: Date.now(), connectionCount: proxy.connections.length }
}
