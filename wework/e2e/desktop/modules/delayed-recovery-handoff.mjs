import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendProcessOutput } from '../process-output.mjs'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { quitInstalledHost } from './installed-startup-history.mjs'
import { routeUpgradeRequests } from './upgrade-request-route.mjs'
import { inspectRunningApp, readConnectedApplicationPid } from './inspect-before-start.mjs'

/** A queued native recovery must not revive B after another process restored A. */
export async function assertDelayedRecoveryHandoffs(options) {
  const { root, targetId, control, installedVersion, expectedVersion } = options
  assert.ok(
    Array.isArray(options.inspectorPorts),
    'Recovery handoffs require the package inspector registry'
  )
  const target = JSON.parse(await readFile(join(root, 'slots', targetId, 'release.json'), 'utf8'))
  const payload = target.macosInstallation.payloadExecutable
  const token = (await readFile(join(root, 'healthy'), 'utf8')).trim()
  for (const nativeRecovery of [true, false]) {
    await assert.rejects(readFile(join(root, 'activation.json')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(root, 'macos-rollback')), { code: 'ENOENT' })
    await quitInstalledHost(root, control)
    const environment = { ...options.environment, WEWORK_RELEASE_ROOT: root }
    delete environment.WEWORK_RELEASE_SUPERVISED
    delete environment.WEWORK_RELEASE_RECOVERY
    if (nativeRecovery) environment.WEWORK_RELEASE_RECOVERY = token
    const readyCount = control.readyCount
    const child = spawn(payload, ['--inspect-brk=127.0.0.1:0'], {
      cwd: options.workspacePath,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log = join(options.resultDir, `delayed-recovery-${nativeRecovery}.log`)
    appendProcessOutput(child.stdout, log)
    appendProcessOutput(child.stderr, log)
    let handedOff = false
    try {
      const port = await routeUpgradeRequests(child, options.origin, log, { followHandoffs: true })
      options.inspectorPorts.push(port)
      await control.awaitReadyAfter(readyCount, options.timeoutMs)
      assert.equal(
        await installedVersion(),
        expectedVersion,
        'A delayed recovery entered the rejected host after the rollback journal was finalized'
      )
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: options.timeoutMs,
      })
      assert.equal(child.exitCode, 0, 'The recovery bootstrap did not exit after its handoff')
      const pid = await readConnectedApplicationPid(control)
      assert.equal(await inspectRunningApp(options.inspectorPorts, pid, 'process.pid'), pid)
      handedOff = true
    } finally {
      if (!handedOff) await stopProcessGroup(child)
    }
  }
}
