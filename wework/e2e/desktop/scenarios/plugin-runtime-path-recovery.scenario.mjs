import assert from 'node:assert/strict'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { requestContainsSkillLocator } from '../modules/desktop-server.mjs'
import {
  verifyPluginEnabledState,
  verifyPluginTogglePersistence,
} from '../modules/plugin-inventory-state.mjs'
import {
  accountPlugin,
  assertInstallButton,
  assertSurfaces,
  openPlugin,
  pluginApi,
  testId,
  uninstallInUi,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import {
  assertCurrentRuntime,
  createBusinessPackage,
  isolatedPath,
  pluginEntry,
  readCapabilityManifest,
  relocateInstalledHome,
  relocatedPath,
  replaceOwnedRuntimeWithForeignDirectory,
} from '../modules/plugin-runtime-path-fixture.mjs'
import {
  assistantMessage,
  functionCall,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  selectTool,
} from '../modules/response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'

const quote = value => `'${value.replaceAll("'", "'\\''")}'`

// Only Responses model output is synthetic. Installs, migrations, runtime reads,
// package files, backend outages and Codex shell execution use real integrations.
export async function createDesktopScenario({
  captureScreenshot,
  electronUserDataDirectory,
  executorHome,
  homePath,
  resultDir,
  workspacePath,
  workbenchReadyTimeoutMs,
}) {
  let cloud
  let restartDesktopApp
  let currentExecutor = executorHome
  let activeCall
  let backendStopped = false
  const evidence = []
  const nextHome = join(resultDir, 'relocated-user-home')
  const nextExecutor = join(nextHome, 'executor')
  const workbench = join(homePath, '.wegent/workbench')
  const nextWorkbench = relocatedPath(workbench, homePath, nextHome)
  const manifest = () => readCapabilityManifest(currentExecutor)
  const entry = async fixture => {
    try {
      return pluginEntry(await manifest(), fixture.installedId)
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async function requestExecutor(control, method) {
    const origin = await control.command('getLocationOrigin', 'body')
    const response = await fetch(`${origin}/wework/executor/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `recovery-${method}`, method, params: {} }),
      signal: AbortSignal.timeout(workbenchReadyTimeoutMs),
    })
    assert.equal(response.ok, true, `Recovery runtime RPC failed: ${method}`)
    const payload = await response.json()
    assert.equal(payload.ok, true, `Recovery runtime is not ready: ${method}`)
    return payload.result
  }

  async function update(fixture, device, data) {
    const response = await fetch(
      `${cloud.backendUrl}/api/plugins/installed/${fixture.installedId}?device_id=${encodeURIComponent(device)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(workbenchReadyTimeoutMs),
      }
    )
    assert.ok(response.ok, `Fixture update failed: HTTP ${response.status}`)
  }

  async function publish(slug, version) {
    const packageRoot = await createBusinessPackage(
      join(resultDir, 'recovery-packages', `${slug}-${version}`),
      slug,
      version
    )
    return { ...(await cloud.publishPluginRelease({ slug, version, packageRoot })), slug }
  }

  async function install(slug, device) {
    const release = await publish(slug, '1.0.0')
    await pluginApi(
      cloud,
      `/plugins/marketplace/${release.pluginId}/install?device_id=${encodeURIComponent(device)}`,
      'POST'
    )
    const installed = await accountPlugin(cloud, slug)
    assert.ok(installed, 'Real account install is missing')
    const fixture = { ...release, installedId: Number(installed.metadata.labels.id) }
    await update(fixture, device, { updatePolicy: 'manual' })
    await waitRuntime(fixture, '1.0.0')
    return fixture
  }

  async function waitRuntime(fixture, version) {
    return until(
      async () => {
        const value = await entry(fixture)
        if (!value?.runtime?.codex_link || value.runtime_recovery_error) return null
        try {
          const metadata = JSON.parse(
            await readFile(join(value.runtime.codex_link, '.codex-plugin/plugin.json'), 'utf8')
          )
          return metadata.version === version ? value : null
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      },
      Boolean,
      `Real runtime did not become usable: ${fixture.slug} ${version}`,
      workbenchReadyTimeoutMs
    )
  }

  async function refresh(control, fixture) {
    await openPlugin(control, fixture)
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    await control.command('waitFor', `${testId('plugins-refresh-button')}:not(:disabled)`, {
      timeoutMs: workbenchReadyTimeoutMs,
    })
  }

  async function invoke(control, fixture, version, phase, { offline = false } = {}) {
    const value = await waitRuntime(fixture, version)
    const id = `recovery-${phase}-${fixture.slug}`
    const prompt = `WEWORK_PLUGIN_RUNTIME_RECOVERY ${id}`
    activeCall = {
      id,
      prompt,
      command: `sh ${quote(join(value.runtime.codex_link, 'scripts/business.sh'))}`,
      expected: `PLUGIN_RECOVERY_OK:${fixture.slug}:${version}`,
      skillName: fixture.slug,
      skillPath: join(value.runtime.codex_link, 'skills', fixture.slug, 'SKILL.md'),
      output: null,
    }
    await control.command('click', testId('new-chat-button'))
    await selectE2EModel(control)
    // Offline execution uses the native reference directly; online phases cover the picker.
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
      value: offline ? `[$${fixture.slug}](plugin://${fixture.slug}@wegent) ${prompt}` : prompt,
    })
    if (!offline) {
      await control.command('click', testId('composer-plugin-picker-button'))
      await control.command('waitFor', testId('composer-plugin-picker'))
      await control.command('fill', testId('composer-plugin-picker-search'), {
        value: fixture.slug,
      })
      await control.command(
        'clickWhenEnabled',
        testId(`composer-plugin-picker-item-plugin:${fixture.slug}`)
      )
    }
    const nativeReference = await control.command(
      'getAttribute',
      testId(`composer-plugin-chip-${fixture.slug}`),
      { value: 'data-composer-skill-reference' }
    )
    assert.ok(
      nativeReference?.includes(`plugin://${fixture.slug}@wegent`),
      'Composer lost the native plugin reference'
    )
    await control.command('clickWhenEnabled', testId('send-message-button'))
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} ${testId('message-assistant')}`,
      {
        text: `${id} completed`,
        timeoutMs: workbenchReadyTimeoutMs,
      }
    )
    assert.ok(activeCall.output?.includes(activeCall.expected), 'Codex did not execute the plugin')
    evidence.push({ phase, plugin: fixture.slug, version, toolOutput: activeCall.output })
    activeCall = null
  }

  async function verifyRecovery(control) {
    const device = (await cloud.waitForConnectedAppDevice()).device_id
    await createSingleRootLocalProject(control, workspacePath, 'plugin-recovery-workspace')
    const primary = await install('recovery-primary', device)
    await refresh(control, primary)
    await invoke(control, primary, '1.0.0', 'before-update')
    const second = await publish(primary.slug, '2.0.0')
    await update(primary, device, { releaseId: second.releaseId })
    const original = await waitRuntime(primary, '2.0.0')
    assert.ok(original.installed_plugin_id > 0 && original.cloud_plugin_id > 0)
    assert.equal(original.previous?.version, '1.0.0', 'Fixture has no real previous install')
    await refresh(control, primary)
    await invoke(control, primary, '2.0.0', 'before-home-change')

    const disabled = await install('recovery-disabled', device)
    const blocked = await install('recovery-occupied', device)
    const missing = await install('recovery-missing', device)
    const removed = await install('recovery-uninstalled', device)
    const componentStates = { [`skill:${disabled.slug}`]: false }
    await update(disabled, device, { enabled: false, componentStates })
    await until(
      () => entry(disabled),
      value =>
        value?.enabled === false && value.component_states?.[`skill:${disabled.slug}`] === false,
      'Disabled/component state did not reach the real runtime',
      workbenchReadyTimeoutMs
    )
    await refresh(control, removed)
    await uninstallInUi(control, removed)
    await assertInstallButton(control, removed)
    await until(
      () => entry(removed),
      value => !value,
      'Uninstall left a managed plugin record'
    )
    const before = await manifest()
    const blockedBefore = pluginEntry(before, blocked.installedId)
    const missingBefore = pluginEntry(before, missing.installedId)
    const ownershipBefore = Object.entries(before.plugin_runtime_owners ?? {})
      .filter(([, key]) => key === original.key)
      .map(([path]) => path)
    assert.ok(ownershipBefore.length >= 2, 'Fixture did not create retained runtime ownership')
    const personal = join(homePath, 'personal-source', primary.slug)
    await createBusinessPackage(personal, primary.slug, '0.0.1-personal')
    await writeFile(join(personal, 'README.md'), 'Personal plugin source must remain untouched\n')
    const personalBytes = await readFile(join(personal, 'README.md'))
    isolatedPath(resultDir, electronUserDataDirectory)
    assert.equal((await lstat(electronUserDataDirectory)).isSymbolicLink(), false)
    const deviceBefore = await readFile(join(electronUserDataDirectory, 'desktop-device-id'))
    // This auth was created by the common runner, never linked to a personal Home.
    const syntheticAuth = await readFile(join(executorHome, 'codex/auth.json'))
    const runtimeBefore = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
    assert.ok(runtimeBefore.executorPid > 0)

    await cloud.stopBackend()
    backendStopped = true
    await restartDesktopApp({
      async afterStop() {
        // Both Home and runtime files really move. No compatibility symlink is left behind.
        currentExecutor = await relocateInstalledHome({
          resultDir,
          oldHome: homePath,
          oldExecutor: executorHome,
          newHome: nextHome,
        })
        const occupied = relocatedPath(blockedBefore.runtime.codex_link, executorHome, nextExecutor)
        await replaceOwnedRuntimeWithForeignDirectory(resultDir, occupied)
        const missingPackage = relocatedPath(missingBefore.store_path, homePath, nextHome)
        isolatedPath(resultDir, missingPackage)
        await rm(missingPackage, { recursive: true })
        for (const field of ['codex_link', 'claude_link']) {
          const old = missingBefore.runtime[field]
          if (!old) continue
          const path = old.startsWith(executorHome + '/')
            ? relocatedPath(old, executorHome, nextExecutor)
            : relocatedPath(old, homePath, nextHome)
          isolatedPath(resultDir, path)
          await rm(path, { recursive: true, force: true })
        }
      },
      appEnvironmentOverrides: {
        HOME: nextHome,
        WEGENT_EXECUTOR_HOME: nextExecutor,
        WEGENT_CODEX_HOME: join(nextExecutor, 'codex'),
        WEGENT_CAPABILITIES_HOME: join(nextExecutor, 'capabilities'),
        WEGENT_WORKBENCH_HOME: nextWorkbench,
        WEWORK_APP_CONFIG_DIR: join(nextHome, 'app-config'),
        WORKSPACE_ROOT: join(nextHome, '.wegent/workspace'),
        WEGENT_STANDALONE_WORKSPACE_ROOT: join(nextHome, 'Documents/Codex'),
      },
    })
    await control.command('waitFor', testId('new-chat-button'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    const configuration = await requestExecutor(control, 'executor.codex_home.config.read')
    assert.equal(configuration.codexHome, join(nextExecutor, 'codex'))
    const startup = await requestExecutor(control, 'runtime.codex.ensure_started')
    assert.equal(startup.ready, true, 'Codex did not really start while the backend was offline')
    const runtimeAfter = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
    assert.ok(runtimeAfter.executorPid > 0)
    assert.notEqual(runtimeAfter.executorPid, runtimeBefore.executorPid)
    assert.ok(
      (await readFile(join(nextExecutor, 'codex/auth.json'))).equals(syntheticAuth),
      'Home recovery changed the isolated synthetic authentication file'
    )
    assert.deepEqual(
      await readFile(join(electronUserDataDirectory, 'desktop-device-id')),
      deviceBefore
    )
    evidence.push({
      phase: 'offline-real-restart',
      previousExecutorPid: runtimeBefore.executorPid,
      currentExecutorPid: runtimeAfter.executorPid,
      codexHome: configuration.codexHome,
    })
    const recovered = await waitRuntime(primary, '2.0.0')
    assertCurrentRuntime(recovered, { home: nextHome, executorHome: nextExecutor })
    assert.equal(recovered.installed_plugin_id, original.installed_plugin_id)
    assert.equal(recovered.cloud_plugin_id, original.cloud_plugin_id)
    assert.equal(recovered.previous.version, '1.0.0')
    assertCurrentRuntime(recovered.previous, { home: nextHome, executorHome: nextExecutor })
    const preservedDisabled = await entry(disabled)
    assert.equal(preservedDisabled.enabled, false)
    assert.deepEqual(preservedDisabled.component_states, componentStates)
    await until(
      async () => [await entry(blocked), await entry(missing)],
      entries => entries.every(value => typeof value?.runtime_recovery_error === 'string'),
      'One-plugin recovery failures were not recorded independently',
      workbenchReadyTimeoutMs
    )
    const foreign = relocatedPath(blockedBefore.runtime.codex_link, executorHome, nextExecutor)
    assert.equal(
      await readFile(join(foreign, 'unrelated-owner.txt'), 'utf8'),
      'Keep this unrelated directory intact\n'
    )
    assert.deepEqual(
      await readFile(join(relocatedPath(personal, homePath, nextHome), 'README.md')),
      personalBytes
    )
    await assert.rejects(lstat(homePath), { code: 'ENOENT' })
    await assert.rejects(lstat(executorHome), { code: 'ENOENT' })
    assert.equal(await entry(removed), undefined, 'Home recovery resurrected an uninstalled plugin')
    const offlineInventory = await requestExecutor(control, 'executor.plugins.store.list')
    for (const fixture of [primary, disabled, blocked, missing]) {
      const item = offlineInventory.plugins.find(item => item.name === fixture.slug)
      assert.ok(item, 'A recovery failure hid an existing plugin from the offline inventory')
      assert.equal(
        item.installedPluginId,
        fixture.installedId,
        'Offline inventory changed the installed plugin identity'
      )
    }
    const offlinePrimary = offlineInventory.plugins.find(item => item.name === primary.slug)
    assert.equal(offlinePrimary.runtimeRecoveryError, null)
    assert.equal(offlinePrimary.version, '2.0.0')
    assert.equal(offlinePrimary.enabled, true)
    isolatedPath(nextHome, offlinePrimary.pluginPath)
    await invoke(control, primary, '2.0.0', 'offline-after-home-change', { offline: true })
    await captureScreenshot(control, 'plugin-home-offline-healthy-plugin-call.png', 'body')
    evidence.push({ phase: 'offline-isolation', failedPlugins: [blocked.slug, missing.slug] })

    await cloud.launchBackend()
    backendStopped = false
    await cloud.waitForConnectedAppDevice()
    await refresh(control, primary)
    await waitRuntime(missing, '1.0.0')
    assert.equal(
      await readFile(join(foreign, 'unrelated-owner.txt'), 'utf8'),
      'Keep this unrelated directory intact\n'
    )
    // A user explicitly clears the unrelated fixture; recovery may now claim the target.
    await restartDesktopApp({
      async afterStop() {
        await rm(foreign, { recursive: true })
      },
    })
    await refresh(control, primary)
    await waitRuntime(blocked, '1.0.0')
    await assertSurfaces(control, primary, true)
    await openPlugin(control, primary)
    await control.command('click', testId(`plugin-marketplace-row-${primary.pluginId}`))
    await control.command('waitFor', testId(`plugin-detail-actions-${primary.installedId}`))
    await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', { text: '立即对话' })
    await verifyPluginEnabledState(control, disabled, false, workbenchReadyTimeoutMs)
    const fresh = await install('recovery-fresh-after-move', device)
    await refresh(control, fresh)
    await assertSurfaces(control, fresh, true)
    const mixed = await manifest()
    for (const fixture of [primary, disabled, blocked, missing, fresh]) {
      assertCurrentRuntime(pluginEntry(mixed, fixture.installedId), {
        home: nextHome,
        executorHome: nextExecutor,
      })
    }
    const owners = Object.entries(mixed.plugin_runtime_owners ?? {}).filter(
      ([, key]) => key === original.key
    )
    assert.ok(owners.length >= ownershipBefore.length, 'Home recovery lost retained ownership')
    assert.ok(
      owners.every(
        ([path]) => !path.startsWith(executorHome + '/') && !path.startsWith(homePath + '/')
      )
    )
    await verifyPluginTogglePersistence({
      control,
      cloud,
      fixture: primary,
      restartDesktopApp,
      timeoutMs: workbenchReadyTimeoutMs,
    })

    await publish(primary.slug, '3.0.0')
    await refresh(control, primary)
    await control.command('click', testId(`plugin-marketplace-row-${primary.pluginId}`))
    await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', { text: '更新' })
    await control.command('click', '[data-testid^="plugin-detail-toggle-"]')
    await control.command('clickWhenEnabled', testId('plugin-update-confirm-button'))
    await waitRuntime(primary, '3.0.0')
    await invoke(control, primary, '3.0.0', 'updated-after-home-change')
    await uninstallInUi(control, primary)
    await assertInstallButton(control, primary)
    await restartDesktopApp()
    await refresh(control, primary)
    assert.equal(
      await entry(primary),
      undefined,
      'Restart revived an explicitly uninstalled plugin'
    )
    await assertSurfaces(control, primary, false)
    await openPlugin(control, primary)
    await control.command(
      'clickWhenEnabled',
      testId(`plugin-marketplace-install-${primary.pluginId}`)
    )
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const reinstalled = await until(
      () => accountPlugin(cloud, primary.slug),
      Boolean,
      'Real reinstall did not restore account membership',
      workbenchReadyTimeoutMs
    )
    primary.installedId = Number(reinstalled.metadata.labels.id)
    await waitRuntime(primary, '3.0.0')
    await refresh(control, primary)
    await invoke(control, primary, '3.0.0', 'reinstalled-after-home-change')
    await verifyPluginEnabledState(control, disabled, false, workbenchReadyTimeoutMs)
    await captureScreenshot(control, 'plugin-home-reinstalled-business-command.png', 'body')
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment: {
      WEGENT_WORKBENCH_HOME: workbench,
      WEGENT_CAPABILITIES_HOME: join(executorHome, 'capabilities'),
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const id = `plugin-recovery-${Date.now()}`
      const result = activeCall ? accountCommandResult(body.input, activeCall.id) : null
      let events
      if (result?.sessionId) {
        const tool = selectTool(body, 'write_stdin', {
          session_id: result.sessionId,
          chars: '',
          yield_time_ms: 1000,
        })
        events = functionCall(result.pollId, tool.name, tool.arguments)
      } else if (result) {
        activeCall.output = result.output
        assert.ok(result.output.includes(activeCall.expected), 'Real plugin command failed')
        events = [assistantMessage(`${activeCall.id} completed`)]
      } else if (
        activeCall &&
        body.tools?.some(tool => ['exec_command', 'shell_command'].includes(tool.name)) &&
        JSON.stringify(body.input ?? '').includes(activeCall.prompt)
      ) {
        assert.ok(
          requestContainsSkillLocator(body, activeCall.skillPath, activeCall.skillName),
          'Real Codex did not discover the selected plugin skill from the recovered runtime'
        )
        const tool = selectShellToolCommand(body, activeCall.command, workspacePath)
        events = functionCall(activeCall.id, tool.name, tool.arguments)
      } else {
        events = [assistantMessage('Plugin recovery fixture ready')]
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        [responseCreated(id), ...events, responseCompleted(id)]
          .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('')
      )
      return true
    },
    async verify(control) {
      try {
        await verifyRecovery(control)
      } finally {
        await writeFile(
          join(resultDir, 'plugin-runtime-path-recovery.json'),
          JSON.stringify(evidence, null, 2)
        )
      }
    },
    async cleanup() {
      if (backendStopped) {
        await cloud.launchBackend()
        backendStopped = false
      }
    },
  }
}
