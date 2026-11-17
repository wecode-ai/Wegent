import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { createSingleRootLocalProject } from './shared.mjs'

/** Reload the real workbench while SQLite's writer slot is held by another connection. */
export async function verifyStartupDatabaseLock({
  control,
  executorHome,
  workspacePath,
  timeoutMs,
}) {
  const rpc = (method, params = {}) => requestExecutor(control, method, params, timeoutMs)
  const workspaceName = 'Startup code workspace'
  await createSingleRootLocalProject(control, workspacePath, workspaceName, timeoutMs)
  const project = await rpc('projects.create', { name: 'Startup lock isolation' })
  // Materialize code-project imports before holding a writer, as in an existing profile.
  await rpc('projects.list')
  const settings = await rpc('runtime.stand_in.personal.get', { userId: 9007 })
  const readRpc = (method, params = {}) =>
    requestExecutor(control, method, params, Math.min(timeoutMs, 4000))
  const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'))
  database.exec('PRAGMA busy_timeout = 1000')
  database.exec('BEGIN IMMEDIATE')
  try {
    const before = control.readyCount
    await control.command('reloadApp', 'body')
    await control.awaitReadyAfter(before, timeoutMs)
    await control.command('waitFor', '[data-testid="app-shell"]', { timeoutMs })
    const [projects, personal, tasks] = await Promise.all([
      readRpc('projects.list'),
      readRpc('runtime.stand_in.personal.get', { userId: 9007 }),
      readRpc('runtime.tasks.list', { preferCached: true }),
      readRpc('runtime.stand_in.telemetry.list', { userId: 9007 }),
    ])
    assert.ok(projects.some(item => item.id === project.id))
    assert.deepEqual(personal, settings)
    assert.equal(tasks.success, true)
    await control.command('waitFor', '[data-testid="model-selector-button"]', { timeoutMs })
    const section = '[data-testid="projects-section-toggle"]'
    if ((await control.command('getAttribute', section, { value: 'aria-expanded' })) === 'false')
      await control.command('clickWhenEnabled', section)
    await control.command('waitFor', 'body', { text: workspaceName, timeoutMs })
    await waitForValue(
      async () => JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')),
      snapshot => snapshot.workbench?.isBootstrapping === false,
      'Startup data did not finish loading while the SQLite writer remained active',
      timeoutMs
    )
    // None of the startup reads may end the other connection's transaction.
    assert.equal(database.isTransaction, true)
  } finally {
    database.exec('ROLLBACK')
    database.close()
  }
  const saved = await rpc('runtime.stand_in.personal.save', { userId: 9007, settings })
  assert.equal(saved.userId, 9007)
}
