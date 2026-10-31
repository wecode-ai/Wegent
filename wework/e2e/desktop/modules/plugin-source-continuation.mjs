import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { requestPluginExecutor, testId } from './plugin-regression-fixture.mjs'
import {
  configureFirstProjectExecutionEnvironment,
  createLocalCollaborationProject,
  openProjectAgentCreator,
  selectProjectRunnerModel,
  waitForControlValueIncludes,
  waitForTestIdByText,
} from './workspace-flows.mjs'
import { createZipFixture } from './zip-fixtures.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PREFIX = 'cloud-project-chat-agent'
const DIALOG = `${PREFIX}-editor`
const PLUGIN_NAME = 'source-continuation-personal'
const PLUGIN_ID = `${PLUGIN_NAME}@wework-personal`
const scoped = selector => `${CONTENT} ${selector}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function assertWithin(root, path) {
  const suffix = relative(root, path)
  assert.ok(
    suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`),
    'Plugin fault target must remain in the isolated E2E result directory'
  )
}

/** A real local source failure must not stop an independent Agent configuration. */
export async function verifyPluginSourceContinuation({
  control,
  resultDir,
  executorHome,
  captureScreenshot,
  workbenchReadyTimeoutMs,
}) {
  const reportPath = join(resultDir, 'plugin-source-continuation-evidence.json')
  const report = {
    scope:
      'Healthy personal plugin selection, save and persistent Agent binding during store failure',
    excluded: ['Plugin tool invocation', 'Cloud plugin installation during a damaged store source'],
    preconditions: { completed: false },
    phases: [],
    faultChecks: [],
  }
  const failures = []
  const root = await realpath(resultDir)
  const manifestPath = join(executorHome, 'capabilities/manifest-v2.json')
  let original
  let mode
  let injected
  let faultActive = false
  let projectId
  const startedAt = Date.now()

  async function replaceManifest(bytes) {
    const staging = `${manifestPath}.source-continuation-${process.pid}.tmp`
    try {
      await writeFile(staging, bytes, { mode })
      await rename(staging, manifestPath)
      await chmod(manifestPath, mode)
    } finally {
      await rm(staging, { force: true })
    }
  }

  async function requestExecutor(method, params = {}, expectedStatus = 200) {
    const { status, payload } = await requestPluginExecutor(control, method, params)
    assert.equal(
      status,
      expectedStatus,
      `Real Executor RPC ${method} returned an unexpected HTTP status`
    )
    return payload
  }

  async function checkFault(label) {
    const bytes = await readFile(manifestPath)
    const value = JSON.parse(bytes)
    const probe = await requestExecutor('executor.plugins.store.list', {}, 500)
    const observation = {
      label,
      manifestMatchesInjection: bytes.equals(injected),
      pluginsMissing: !Object.hasOwn(value, 'plugins'),
      storeRejected: probe.ok === false,
      errorCode: probe.error?.code,
      missingPluginsError: /missing plugins/.test(probe.error?.message ?? ''),
    }
    report.faultChecks.push(observation)
    assert.ok(observation.manifestMatchesInjection, 'The injected source changed during the test')
    assert.ok(observation.pluginsMissing, 'Background work repaired the injected source fault')
    assert.ok(observation.storeRejected, 'The real store source did not reject the damaged record')
    assert.equal(observation.errorCode, 'plugin_store_list_failed')
    assert.ok(observation.missingPluginsError, 'Store source failed for an unrelated reason')
  }

  async function closeForm() {
    if (Number(await control.command('getElementCount', testId(DIALOG), { visible: true }))) {
      await control.command('click', testId(`${PREFIX}-cancel`))
      await control.command('waitFor', testId(DIALOG), { visible: false })
    }
  }

  async function configureAgent(entry) {
    const name = `Plugin continuation ${entry.name} ${process.pid}`
    if (faultActive) await checkFault(`${entry.name}-before-new-form`)
    await openProjectAgentCreator(control, scoped(testId('project-agent-add')), 10_000)
    await control.command('fill', testId(`${PREFIX}-display-name`), { value: name })
    await selectProjectRunnerModel(control, 10_000)
    await control.command('click', testId(`${DIALOG}-advanced-toggle`))
    await control.command('click', testId(`${PREFIX}-capability-mode-manual`))
    await control.command('clickWhenEnabled', testId(`${PREFIX}-plugins-add`))
    await control.command('waitFor', testId(`${PREFIX}-plugins-picker`))
    const candidate = testId(`${PREFIX}-plugin-${PLUGIN_ID}`)
    try {
      await control.command('waitFor', candidate, { enabled: true })
    } finally {
      const snapshot = JSON.parse(await control.command('snapshot', testId(DIALOG)))
      entry.personalCandidateAvailable = snapshot.testIds.includes(`${PREFIX}-plugin-${PLUGIN_ID}`)
      if (faultActive) await checkFault(`${entry.name}-after-candidate-load`)
    }
    await control.command('click', candidate)
    await control.command('waitFor', testId(`${PREFIX}-plugins-picker`), { visible: false })
    await captureScreenshot(
      control,
      `plugin-source-continuation-${entry.name}-selected.png`,
      'body'
    )
    if (faultActive) await checkFault(`${entry.name}-before-save`)
    await control.command('clickWhenEnabled', testId(`${PREFIX}-save`))
    await control.command('waitFor', testId(DIALOG), { visible: false })
    const rowId = await waitForTestIdByText(
      control,
      scoped(testId('project-agent-list')),
      'project-agent-row-',
      name,
      10_000
    )
    entry.savedAgentId = rowId.slice('project-agent-row-'.length)
    const persisted = await requestExecutor('chat_agents.list', { project_id: projectId })
    assert.equal(persisted.ok, true, 'The real local Agent read failed after saving')
    const agent = persisted.result.find(item => item.id === entry.savedAgentId)
    assert.ok(agent, 'The saved Agent is absent from local persistent storage')
    assert.equal(agent.capability_mode, 'manual')
    assert.ok(agent.plugins.some(plugin => plugin.id === PLUGIN_ID))
    entry.persistedPluginBinding = true
    await control.command('click', scoped(testId(`project-agent-edit-${entry.savedAgentId}`)))
    await control.command('waitFor', testId(`${PREFIX}-display-name`))
    await waitForControlValueIncludes(
      control,
      testId(`${PREFIX}-display-name`),
      name,
      'The reopened Agent must show its saved name',
      10_000
    )
    assert.equal(await control.command('getValue', testId(`${PREFIX}-display-name`)), name)
    await control.command('click', testId(`${DIALOG}-advanced-toggle`))
    await control.command('clickWhenEnabled', testId(`${PREFIX}-plugins-add`))
    await control.command('waitFor', `${candidate}:checked`)
    entry.persistedPluginBindingSelected = true
    if (faultActive) await checkFault(`${entry.name}-after-reopen`)
    await control.command('click', testId(`${PREFIX}-plugins-add`))
    await closeForm()
  }

  async function phase(name) {
    const entry = { name, passed: false, startedAt: Date.now() }
    report.phases.push(entry)
    try {
      await configureAgent(entry)
      entry.passed = true
    } catch (error) {
      entry.error = String(error?.message ?? error)
      failures.push(new Error(`${name}: ${entry.error}`, { cause: error }))
    } finally {
      entry.elapsedMs = Date.now() - entry.startedAt
      const screenshot = `plugin-source-continuation-${name}.png`
      try {
        await captureScreenshot(control, screenshot, 'body')
        entry.screenshot = screenshot
      } catch (error) {
        entry.evidenceError = String(error?.message ?? error)
        entry.passed = false
        failures.push(new Error(`${name}: evidence capture failed`, { cause: error }))
      }
      try {
        await closeForm()
      } catch (error) {
        entry.cleanupError = String(error?.message ?? error)
        entry.passed = false
        failures.push(new Error(`${name}: form cleanup failed`, { cause: error }))
      }
    }
    return entry
  }

  try {
    const fixtureRoot = join(resultDir, 'plugin-source-continuation-fixture')
    await mkdir(fixtureRoot, { recursive: true })
    const archivePath = join(fixtureRoot, `${PLUGIN_NAME}.zip`)
    const bundled = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
    const marketplacePath = bundled.marketplace?.path
    assert.equal(typeof marketplacePath, 'string', 'The real personal marketplace was not ready')
    assertWithin(root, await realpath(marketplacePath))
    await createZipFixture(archivePath, {
      '.codex-plugin/plugin.json': JSON.stringify({
        name: PLUGIN_NAME,
        version: '1.0.0',
        description: 'Independent personal plugin for real source isolation verification',
        author: { name: 'Wework Desktop E2E' },
        skills: './skills/',
        interface: {
          displayName: 'Source Continuation Personal',
          shortDescription: 'Verifies independent plugin continuation',
          longDescription: 'Verifies Agent configuration while a separate store source fails.',
          developerName: 'Wework Desktop E2E',
          category: 'Developer Tools',
          capabilities: ['Skills'],
          defaultPrompt: 'Verify independent plugin continuation.',
        },
      }),
      'skills/source-continuation/SKILL.md':
        '---\nname: source-continuation\ndescription: Verify independent plugin continuation.\n---\n',
    })
    const preview = JSON.parse(
      await control.command('previewPluginImport', 'body', {
        value: JSON.stringify({ archivePath, marketplacePath }),
      })
    )
    report.preconditions.packageIssues = preview.issues
    assert.equal(
      preview.valid,
      true,
      `The real personal plugin package preview failed: ${JSON.stringify(preview.issues)}`
    )
    const imported = JSON.parse(
      await control.command('importPluginPackage', 'body', {
        value: JSON.stringify({ preview, overwrite: false }),
      })
    )
    assert.equal(imported.pluginName, PLUGIN_NAME)
    const resolvedManifest = await realpath(manifestPath)
    assertWithin(root, resolvedManifest)
    const metadata = await lstat(manifestPath)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink())
    assert.equal(metadata.nlink, 1, 'Fault target must not be linked to another manifest')
    original = await readFile(manifestPath)
    mode = metadata.mode & 0o777
    const manifest = JSON.parse(original)
    assert.equal(manifest.version, 2)
    assert.ok(manifest.plugins && typeof manifest.plugins === 'object')
    report.originalManifestSha256 = hash(original)

    await ensureExperimentalFeaturesEnabled(control)
    await control.command('click', testId('workspace-tab-select-fixed-board'))
    const projectName = `Plugin continuation ${process.pid}`
    await createLocalCollaborationProject(control, CONTENT, projectName)
    const projects = await requestExecutor('projects.list')
    assert.equal(projects.ok, true)
    projectId = projects.result.find(item => item.name === projectName)?.id
    assert.ok(projectId, 'The new local project is missing from the real project catalog')
    await configureFirstProjectExecutionEnvironment(control, CONTENT, workbenchReadyTimeoutMs)
    await control.command('click', scoped(testId('collaboration-tab-manage')))
    await control.command('click', scoped(testId('collaboration-project-settings-agents')))
    const normal = await phase('healthy-before-fault')
    assert.ok(normal.passed, 'The healthy personal plugin selection/save precondition failed')
    report.preconditions.completed = true

    // Capture the latest normal bytes after all healthy setup mutations settle.
    assertWithin(root, await realpath(manifestPath))
    const currentMetadata = await lstat(manifestPath)
    assert.ok(currentMetadata.isFile() && !currentMetadata.isSymbolicLink())
    assert.equal(currentMetadata.nlink, 1)
    mode = currentMetadata.mode & 0o777
    original = await readFile(manifestPath)
    const damaged = JSON.parse(original)
    assert.equal(damaged.version, 2)
    assert.ok(Object.hasOwn(damaged, 'plugins'))
    delete damaged.plugins
    injected = Buffer.from(`${JSON.stringify(damaged, null, 2)}\n`)
    report.originalManifestSha256 = hash(original)
    report.injectedManifestSha256 = hash(injected)
    faultActive = true
    try {
      await replaceManifest(injected)
      await checkFault('injection-established')
      const personal = await requestExecutor('executor.plugins.personal.list', { marketplacePath })
      const config = await requestExecutor('executor.codex_home.config.read')
      assert.equal(personal.ok, true, 'The independent personal source must remain healthy')
      assert.equal(config.ok, true, 'The independent configuration source must remain healthy')
      report.healthySources = {
        personal: personal.ok,
        config: config.ok,
        personalFixturePresent: personal.result.plugins.some(plugin => plugin.name === PLUGIN_NAME),
        personalFixtureEnabled: config.result.enabledPluginKeys.includes(PLUGIN_ID),
      }
      assert.ok(report.healthySources.personalFixturePresent)
      assert.ok(report.healthySources.personalFixtureEnabled)
      await phase('store-fault-other-flow-continues')
      await checkFault('fault-still-present-after-user-flow')
    } finally {
      await replaceManifest(original)
      assert.ok((await readFile(manifestPath)).equals(original))
      faultActive = false
      report.manifestRestored = true
    }
    const recovered = await requestExecutor('executor.plugins.store.list')
    assert.equal(recovered.ok, true, 'The restored real store source did not recover')
    await phase('recovered-source-other-flow')
  } catch (error) {
    report.environmentOrSetupError = String(error?.message ?? error)
    failures.push(error)
  } finally {
    if (faultActive && original) {
      await replaceManifest(original)
      report.manifestRestored = (await readFile(manifestPath)).equals(original)
    }
    report.elapsedMs = Date.now() - startedAt
    report.faultValid =
      report.faultChecks.length > 0 &&
      report.faultChecks.every(
        check =>
          check.manifestMatchesInjection &&
          check.pluginsMissing &&
          check.storeRejected &&
          check.errorCode === 'plugin_store_list_failed' &&
          check.missingPluginsError
      )
    report.passed = report.preconditions.completed && failures.length === 0
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  if (failures.length) throw new AggregateError(failures, 'Plugin source continuation failed')
  return { reportPath }
}
