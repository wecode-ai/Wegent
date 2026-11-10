import assert from 'node:assert/strict'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRunningApp } from './inspect-before-start.mjs'

const LEGACY = 'manifest.json'
const CURRENT = 'manifest-v2.json'
const BACKUP_PREFIX = 'manifest.json.empty-'
const HISTORICAL_BACKUP = `${BACKUP_PREFIX}previous-upgrade`
const HISTORICAL_CONTENT = '{"version":1,"revision":7}\n'

// Serialized into the isolated, real source Electron process by the driver.
function seedOnUpgradeRelaunch({ root, capabilities, targetVersion, executorPid, fixture }) {
  const require = process.getBuiltinModule('module').createRequire(process.execPath)
  const { app } = require('electron')
  const assert = process.getBuiltinModule('node:assert/strict')
  const fs = process.getBuiltinModule('node:fs')
  const { join } = process.getBuiltinModule('node:path')
  const relaunch = app.relaunch
  app.relaunch = function (...args) {
    app.relaunch = relaunch
    const active = fs.readFileSync(join(root, 'active'), 'utf8').trim()
    const activation = JSON.parse(fs.readFileSync(join(root, 'activation.json'), 'utf8'))
    assert.equal(active, activation.to, 'Seed only after the real update selects its target')
    assert.notEqual(activation.from, active)
    assert.ok(fs.existsSync(join(root, 'snapshots', activation.snapshot, 'snapshot.json')))
    assert.equal(
      JSON.parse(fs.readFileSync(join(root, 'slots', active, 'release.json'), 'utf8')).version,
      targetVersion
    )
    assert.throws(
      () => process.kill(executorPid, 0),
      { code: 'ESRCH' },
      'The source executor must stop before the manifest fixture changes'
    )
    const historical = join(capabilities, fixture.history)
    fs.mkdirSync(capabilities, { recursive: true })
    fs.mkdirSync(historical)
    fs.writeFileSync(join(historical, fixture.legacy), fixture.historyContent, { flag: 'wx' })
    const legacy = join(capabilities, fixture.legacy)
    fs.rmSync(legacy, { force: true })
    fs.writeFileSync(legacy, '', { flag: 'wx' })
    fs.rmSync(join(capabilities, fixture.current), { force: true })
    return relaunch.apply(this, args)
  }
}

export function emptyManifestRelaunchScript(options) {
  return `(${seedOnUpgradeRelaunch.toString()})(${JSON.stringify({
    ...options,
    fixture: {
      legacy: LEGACY,
      current: CURRENT,
      history: HISTORICAL_BACKUP,
      historyContent: HISTORICAL_CONTENT,
    },
  })})`
}

export async function armEmptyManifestUpgrade(inspectorPort, applicationPid, options) {
  assert.ok(Number.isSafeInteger(applicationPid) && applicationPid > 0)
  assert.ok(Number.isSafeInteger(options.executorPid) && options.executorPid > 0)
  await inspectRunningApp(inspectorPort, applicationPid, emptyManifestRelaunchScript(options))
}

export async function assertEmptyManifestBackups(capabilities) {
  const backups = (await readdir(capabilities)).filter(name => name.startsWith(BACKUP_PREFIX))
  assert.equal(backups.length, 2, 'Expected one historical backup and one new backup')
  assert.ok(backups.includes(HISTORICAL_BACKUP))
  const backup = backups.find(name => name !== HISTORICAL_BACKUP)
  const archived = await lstat(join(capabilities, backup, LEGACY))
  assert.ok(archived.isFile() && archived.size === 0, 'The new backup must preserve the empty file')
  assert.equal(
    await readFile(join(capabilities, HISTORICAL_BACKUP, LEGACY), 'utf8'),
    HISTORICAL_CONTENT,
    'The historical backup changed'
  )
  return { backup, historicalBackup: HISTORICAL_BACKUP }
}

export async function assertEmptyManifestRecovery(capabilities) {
  await assert.rejects(lstat(join(capabilities, LEGACY)), { code: 'ENOENT' })
  const manifest = JSON.parse(await readFile(join(capabilities, CURRENT), 'utf8'))
  assert.equal(manifest.version, 2)
  for (const key of ['skills', 'plugins', 'mcps'])
    assert.ok(manifest[key] && typeof manifest[key] === 'object' && !Array.isArray(manifest[key]))
  return { ...(await assertEmptyManifestBackups(capabilities)), schemaVersion: manifest.version }
}

export async function restartUpgradedHost(control, inspectorPort, timeoutMs) {
  const { applicationPid } = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  assert.ok(Number.isSafeInteger(applicationPid) && applicationPid > 0)
  const readyCount = control.readyCount
  await inspectRunningApp(
    inspectorPort,
    applicationPid,
    "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.relaunch()"
  )
  await control.command('quitApp', 'body')
  await control.awaitReadyAfter(readyCount, timeoutMs)
  const restarted = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  assert.ok(Number.isSafeInteger(restarted.applicationPid) && restarted.applicationPid > 0)
  assert.notEqual(restarted.applicationPid, applicationPid, 'Expected a new target host process')
}
