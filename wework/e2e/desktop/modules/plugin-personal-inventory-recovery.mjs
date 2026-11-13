import assert from 'node:assert/strict'
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  assertInventory,
  inventory,
  openComposerPluginPicker,
  pathExists,
  requestPluginExecutor,
  testId,
} from './plugin-regression-fixture.mjs'
import { refreshPluginInventory } from './plugin-inventory-state.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { createZipFixture } from './zip-fixtures.mjs'

const NAME = 'personal-inventory-recovery'
const CODEX_GATE = `${NAME}-codex`

async function isolatedPath(root, candidate) {
  const resolved = await realpath(candidate)
  const suffix = relative(await realpath(root), resolved)
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  return resolved
}

async function installFixture(control, resultDir, report) {
  const directory = join(resultDir, NAME)
  await mkdir(directory, { recursive: true })
  const archivePath = join(directory, `${NAME}.zip`)
  const bundled = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
  const marketplacePath = bundled.marketplace?.path
  assert.equal(typeof marketplacePath, 'string')
  await isolatedPath(resultDir, marketplacePath)
  await createZipFixture(archivePath, {
    '.codex-plugin/plugin.json': JSON.stringify({
      name: NAME,
      version: '1.0.0',
      description: 'Verify personal membership survives stale Codex recovery.',
      author: { name: 'Wework Desktop E2E' },
      skills: './skills/',
      interface: {
        displayName: 'Personal Inventory Recovery',
        shortDescription: 'Verifies authoritative personal membership',
        longDescription: 'Verifies removed personal plugins stay absent after runtime recovery.',
        developerName: 'Wework Desktop E2E',
        category: 'Developer Tools',
        capabilities: ['Skills'],
        defaultPrompt: 'Verify personal inventory recovery.',
      },
    }),
    'skills/recovery/SKILL.md':
      '---\nname: recovery\ndescription: Verify personal inventory recovery.\n---\n',
  })
  const preview = JSON.parse(
    await control.command('previewPluginImport', 'body', {
      value: JSON.stringify({ archivePath, marketplacePath }),
    })
  )
  assert.equal(preview.valid, true, JSON.stringify(preview.issues))
  assert.equal(preview.name, NAME, 'The preview must identify the isolated fixture')
  assert.equal(preview.existing, false, 'The personal inventory fixture already exists')
  // Import can commit without returning a receipt. Reserve cleanup for this
  // known absent fixture before starting the mutation; deletion is idempotent.
  report.importAttempted = true
  const importedResponse = await control.command('importPluginPackage', 'body', {
    value: JSON.stringify({ preview, overwrite: false }),
  })
  report.imported = true
  const imported = JSON.parse(importedResponse)
  assert.equal(imported.pluginName, NAME)
  const { status, payload } = await requestPluginExecutor(
    control,
    'executor.plugins.personal.list',
    {
      marketplacePath,
    }
  )
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  const plugin = payload.result.plugins.find(plugin => plugin.name === NAME)
  assert.ok(plugin, 'The real personal source must exist before capturing membership')
  const source = await isolatedPath(resultDir, plugin.pluginPath)
  return { source, backup: join(directory, 'removed-source') }
}

function assertMembership(state, present) {
  const personal = state.installedSourceReads.personal
  assert.equal(personal?.status, 'fulfilled')
  assert.equal(personal.pluginKeys.includes(NAME), present)
  assert.equal(state.installedSourceReads.codex.pluginKeys.includes(NAME), false)
  assert.equal(
    state.installedPlugins.some(plugin => plugin.pluginKey === NAME),
    present
  )
}

/** A real Codex inventory must not revive a disk-confirmed removed source. */
export async function verifyPersonalInventoryRecovery({
  control,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const reportPath = join(resultDir, `${NAME}-evidence.json`)
  const report = { passed: false }
  const gates = runtimeTransportGates(control)
  let fixture
  let removed = false
  let failure
  const catalog = () => control.command('reconcileLocalPluginCatalog', 'body')
  const disk = () => control.command('readLocalPluginDiskInventory', 'body')
  try {
    fixture = await installFixture(control, resultDir, report)
    await catalog()
    await control.command('click', testId('new-chat-button'))
    await openComposerPluginPicker(control)
    await assertInventory(control, NAME, true)
    await control.command('click', testId('composer-plugin-picker-button'), { visible: true })
    await rename(fixture.source, fixture.backup)
    removed = true
    // Do not scan disk first: the full refresh itself must discover this external deletion.
    assert.equal(await pathExists(fixture.source), false, 'Background work restored the source')
    await gates.arm({
      id: CODEX_GATE,
      kind: 'response',
      name: 'codex.app_server_request',
      hold: false,
      where: [{ path: 'params.method', equals: 'plugin/installed' }],
    })
    await catalog()
    const codexCapture = await gates.wait(CODEX_GATE)
    assert.ok(
      codexCapture.value.result.marketplaces.some(
        marketplace =>
          marketplace.name === 'wework-personal' &&
          marketplace.plugins.some(plugin => plugin.name === NAME)
      ),
      'The real Codex installed cache must still contain the removed personal source'
    )
    report.afterRecovery = await inventory(control)
    assert.equal(await pathExists(fixture.source), false, 'Recovery restored the source')
    assertMembership(report.afterRecovery, false)
    report.transport = {
      codexCapturedAt: codexCapture.capturedAt,
      codexDelivered: (await gates.read(CODEX_GATE)).deliveries,
    }
    assert.equal(report.transport.codexDelivered, 1)
    await control.command('click', testId('plugins-button'))
    await refreshPluginInventory(control, workbenchReadyTimeoutMs)
    await assertInventory(control, NAME, false)

    // Lose renderer memory without changing the real source, config or installed cache.
    const ready = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await control.awaitReadyAfter(ready, workbenchReadyTimeoutMs)
    await control.command('waitFor', testId('plugins-button'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await catalog()
    await control.command('click', testId('new-chat-button'))
    await openComposerPluginPicker(control)
    report.afterReload = await inventory(control)
    assertMembership(report.afterReload, false)
    await assertInventory(control, NAME, false)
    await control.command('click', testId('composer-plugin-picker-button'), { visible: true })
    await control.command('click', testId('plugins-button'))
    await refreshPluginInventory(control, workbenchReadyTimeoutMs)
    await assertInventory(control, NAME, false)

    await rename(fixture.backup, fixture.source)
    removed = false
    await disk()
    await catalog()
    report.afterRestore = await inventory(control)
    assertMembership(report.afterRestore, true)
    await refreshPluginInventory(control, workbenchReadyTimeoutMs)
    await assertInventory(control, NAME, true)
    report.passed = true
    return { reportPath }
  } catch (error) {
    failure = error
    report.error = String(error?.stack ?? error)
    throw error
  } finally {
    try {
      await gates.reset()
      if (removed) await rename(fixture.backup, fixture.source)
      if (report.importAttempted) {
        await control.command('deleteLocalPluginPackage', 'body', {
          value: JSON.stringify({ pluginId: `${NAME}@wework-personal`, pluginName: NAME }),
        })
        // Once the source is gone, drain the shared cache lock and remove any
        // cache committed by an import that outlived its original receipt.
        await control.command('uninstallInstalledPlugin', 'body', {
          value: `${NAME}@wework-personal`,
        })
        await control.command('click', testId('plugins-button'))
        await refreshPluginInventory(control, workbenchReadyTimeoutMs)
        await assertInventory(control, NAME, false)
      }
    } catch (error) {
      report.passed = false
      report.cleanupError = String(error?.stack ?? error)
      if (!failure) throw error
    } finally {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    }
  }
}
