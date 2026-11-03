import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { requestContainsSkillLocator } from '../modules/desktop-server.mjs'
import {
  refreshPluginInventory,
  verifyPluginEnabledState,
} from '../modules/plugin-inventory-state.mjs'
import {
  HISTORICAL_PLUGIN_UPDATE,
  HISTORICAL_PLUGIN_SOURCE,
  LEGACY_PLUGIN_RELEASES,
  historicalPluginPackages,
  prepareHistoricalPluginTools,
  readHistoricalPluginState,
  startHistoricalPluginExecutor,
} from '../modules/legacy-plugin-executor.mjs'
import {
  accountPlugin,
  assertInstallButton,
  openPlugin,
  pluginApi,
  testId,
  uninstallInUi,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import { packagedResourcesRoot } from '../modules/workbench-schema-compatibility.mjs'
import {
  assistantMessage,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  requestAdvertisesShellCommand,
  shellCommandPollResponse,
  shellCommandResponse,
} from '../modules/shell-command-response.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'

const quote = value => `'${value.replaceAll("'", "'\\''")}'`

/** QA: real old installers -> production Home migration -> update/uninstall/reinstall.
 * Each baseline owns a clean Home. Assert its original schema and marketplace
 * target before launch, preserve disabled/config state and immutable legacy data,
 * execute the selected native plugin through real Codex, and check restart does
 * not resurrect removed installations. Shared runner cleanup owns every process.
 */
export async function createDesktopScenario({
  homePath,
  resultDir,
  workspacePath,
  workbenchReadyTimeoutMs,
  captureScreenshot,
}) {
  let cloud
  let restart
  let namespace
  let seedConfig
  let active
  let pluginTools
  let updatePackages
  let current
  const evidence = []
  const publishedReleases = new Map()
  const userHomeFor = release => join(homePath, `legacy-${release.version}`)
  const rootFor = release =>
    namespace
      ? join(userHomeFor(release), '.wework/apps', namespace)
      : join(userHomeFor(release), '.wework')
  const workbenchFor = release => join(userHomeFor(release), '.wegent/workbench')
  const desktopFor = release => join(workbenchFor(release), 'wework', namespace || 'default')
  const environment = release => ({
    ...pluginTools,
    HOME: userHomeFor(release),
    USERPROFILE: userHomeFor(release),
    WEGENT_EXECUTOR_HOME: undefined,
    WEGENT_WORKBENCH_HOME: workbenchFor(release),
    WEGENT_CODEX_HOME: undefined,
    CODEX_HOME: undefined,
    CODEX_SQLITE_HOME: undefined,
    WEGENT_CAPABILITIES_HOME: undefined,
    WEGENT_CLAUDE_HOME: undefined,
    CLAUDE_CONFIG_DIR: undefined,
  })
  const state = async () =>
    JSON.parse(
      await readFile(join(desktopFor(current.release), 'capabilities/manifest-v2.json'), 'utf8')
    )
  const entry = async fixture => (await state()).plugins[`${fixture.slug}@wegent`]

  async function publish(fixture) {
    const key = `${fixture.slug}@${fixture.version}`
    const existing = publishedReleases.get(key)
    if (existing) {
      assert.deepEqual(fixture.files, existing.files, 'Historical release content changed')
      return { ...fixture, ...existing.release }
    }
    const release = await cloud.publishPluginRelease(fixture)
    publishedReleases.set(key, { files: fixture.files, release })
    return { ...fixture, ...release }
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
    assert.ok(response.ok, `Historical plugin update failed: HTTP ${response.status}`)
  }

  async function seed(release) {
    const root = rootFor(release)
    await mkdir(join(root, 'codex'), { recursive: true })
    await copyFile(seedConfig, join(root, 'codex/config.toml'))
    const userSkill = join(userHomeFor(release), 'personal-skill/SKILL.md')
    await mkdir(join(userHomeFor(release), 'personal-skill'), { recursive: true })
    await writeFile(
      userSkill,
      '---\nname: legacy-personal-skill\ndescription: Unrelated user skill\n---\nUser-owned configuration marker\n'
    )
    const configPath = join(root, 'codex/config.toml')
    await writeFile(
      configPath,
      `${await readFile(configPath, 'utf8')}\n[skills]\nconfig = [{ path = ${JSON.stringify(userSkill)}, enabled = false }]\n[mcp_servers.legacy-user-disabled]\ncommand = "node"\nargs = ["--version"]\nenabled = false\n`
    )
    const installer = await startHistoricalPluginExecutor({
      release,
      cloud,
      root,
      userHome: userHomeFor(release),
      directory: join(resultDir, 'historical-executors', release.version),
    })
    const delivered = await historicalPluginPackages(
      HISTORICAL_PLUGIN_SOURCE,
      join(resultDir, 'historical-plugins', HISTORICAL_PLUGIN_SOURCE.version)
    )
    evidence.push({
      phase: 'delivered-plugin-package',
      executorVersion: release.version,
      ...delivered.evidence,
    })
    const fixtures = {}
    try {
      for (const [role, original] of Object.entries(delivered.packages)) {
        const fixture = await publish(original)
        await pluginApi(
          cloud,
          `/plugins/marketplace/${fixture.pluginId}/install?device_id=${installer.deviceId}`,
          'POST'
        )
        fixture.installedId = Number((await accountPlugin(cloud, fixture.slug)).metadata.labels.id)
        await update(fixture, installer.deviceId, { releaseId: fixture.releaseId })
        await update(fixture, installer.deviceId, {
          updatePolicy: 'manual',
          ...(role === 'disabled'
            ? { enabled: false, componentStates: { [`skill:${fixture.skillName}`]: false } }
            : {}),
        })
        fixtures[role] = fixture
      }
      const original = await until(
        () => readHistoricalPluginState(root, release),
        value =>
          Object.values(fixtures).every(
            fixture => value.value.plugins[`${fixture.slug}@wegent`]?.version === fixture.version
          ) &&
          value.value.plugins[`${fixtures.disabled.slug}@wegent`]?.enabled === false &&
          value.value.plugins[`${fixtures.disabled.slug}@wegent`]?.component_states?.[
            `skill:${fixtures.disabled.skillName}`
          ] === false,
        'The delivered historical installer did not materialize the plugins',
        workbenchReadyTimeoutMs
      )
      const records = Object.fromEntries(
        Object.values(fixtures).map(fixture => {
          const value = original.value.plugins[`${fixture.slug}@wegent`]
          return [
            fixture.slug,
            Object.fromEntries(
              [
                'managed',
                'name',
                'key',
                'marketplace',
                'installed_plugin_id',
                'version',
                'checksum',
                'store_path',
                'runtime',
                'enabled',
                'component_states',
              ].map(key => [key, value[key]])
            ),
          ]
        })
      )
      await writeFile(
        join(resultDir, `legacy-source-${release.version}-state.json`),
        JSON.stringify(records, null, 2)
      )
      for (const fixture of Object.values(fixtures)) {
        const record = original.value.plugins[`${fixture.slug}@wegent`]
        const market = join(root, 'codex/plugins/marketplaces/wegent/plugins', fixture.slug)
        const source = release.source === 'store' ? record.store_path : record.runtime.codex_link
        if (process.platform !== 'win32')
          assert.equal(
            await readlink(market),
            source,
            'Historical fixture has the wrong real layout'
          )
        assert.ok((await lstat(source)).isDirectory())
      }
      evidence.push({
        ...installer.evidence,
        schema: original.value.version,
        source: release.source,
      })
    } finally {
      await installer.stop()
    }
    return {
      release,
      fixtures,
      legacyManifest: await readFile(
        join(root, 'capabilities', release.schema === 1 ? 'manifest.json' : 'manifest-v2.json')
      ),
    }
  }

  async function waitRuntime(fixture, version) {
    return until(
      () => entry(fixture),
      value =>
        value?.version === version &&
        !value.runtime_recovery_error &&
        value.runtime.codex_link.startsWith(desktopFor(current.release)),
      `Migrated ${fixture.slug} did not reach ${version}`,
      workbenchReadyTimeoutMs
    )
  }

  async function invoke(control, fixture) {
    const { version } = fixture
    const record = await waitRuntime(fixture, version)
    for (const [path, checksum] of Object.entries(fixture.files)) {
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(record.runtime.codex_link, path)))
          .digest('hex'),
        checksum,
        `Migration changed a delivered plugin file: ${path}`
      )
    }
    const id = `legacy-business-${Date.now()}`
    active = {
      id,
      prompt: `WEWORK_LEGACY_PLUGIN ${id}`,
      output: null,
      command: `node ${quote(join(record.runtime.codex_link, 'scripts/smart-app-tool.mjs'))} doctor`,
      expected: '"pnpmAvailable": true',
      skillPath: join(record.runtime.codex_link, 'skills', fixture.skillName, 'SKILL.md'),
      skillName: fixture.skillName,
    }
    await control.command('click', testId('new-chat-button'))
    await selectE2EModel(control)
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} ${testId('composer-plugin-picker-button')}`
    )
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
      value: `[$${fixture.slug}](plugin://${fixture.slug}@wegent) ${active.prompt}`,
    })
    await control.command('clickWhenEnabled', testId('send-message-button'))
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} ${testId('message-assistant')}`,
      { text: `${id} completed`, timeoutMs: workbenchReadyTimeoutMs }
    )
    assert.ok(
      active.output?.includes(active.expected),
      'The real native consumer did not execute the migrated plugin'
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} ${testId('composer-plugin-picker-button')}`,
      { visible: false }
    )
    evidence.push({
      sourceVersion: current.release.version,
      plugin: fixture.slug,
      version,
      runtime: record.runtime.codex_link,
      output: active.output,
    })
    active = null
  }

  async function verifyBaseline(control) {
    await control.command('waitFor', testId('new-chat-button'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    const device = (await cloud.waitForConnectedAppDevice()).device_id
    await createSingleRootLocalProject(control, workspacePath, `legacy-${current.release.version}`)
    const { fixtures, release } = current
    await waitRuntime(fixtures.update, fixtures.update.version)
    assert.equal((await entry(fixtures.disabled)).enabled, false)
    assert.equal(
      (await entry(fixtures.disabled)).component_states[`skill:${fixtures.disabled.skillName}`],
      false
    )
    const config = await readFile(join(desktopFor(release), 'codex/config.toml'), 'utf8')
    assert.ok(
      config.includes('mcp_servers.legacy-user-disabled'),
      'Migration discarded an unrelated legacy MCP configuration'
    )
    assert.ok(
      config.includes(join(userHomeFor(release), 'personal-skill/SKILL.md')),
      'Migration changed a user-owned skill selector'
    )
    assert.ok(
      config.includes(desktopFor(release)),
      'The native marketplace configuration did not migrate'
    )
    if (release.schema === 1)
      assert.deepEqual(
        await readFile(join(desktopFor(release), 'capabilities/manifest.json')),
        current.legacyManifest,
        'Legacy evidence was rewritten'
      )
    await invoke(control, fixtures.update)
    const latest = await publish(updatePackages.update)
    await update(fixtures.update, device, { releaseId: latest.releaseId })
    latest.installedId = fixtures.update.installedId
    await invoke(control, latest)
    await uninstallInUi(control, latest)
    await assertInstallButton(control, latest)
    await until(
      () => entry(latest),
      value => !value,
      'Migration uninstall retained an active record',
      workbenchReadyTimeoutMs
    )
    await restart()
    await control.command('waitFor', testId('new-chat-button'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    assert.equal(
      await entry(latest),
      undefined,
      'Restart resurrected the removed historical plugin'
    )
    await openPlugin(control, latest)
    await control.command(
      'clickWhenEnabled',
      testId(`plugin-marketplace-install-${latest.pluginId}`)
    )
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const installed = await until(
      () => accountPlugin(cloud, latest.slug),
      Boolean,
      'Reinstall did not restore account membership',
      workbenchReadyTimeoutMs
    )
    assert.equal(
      Number(installed.metadata.labels.id),
      latest.installedId,
      'Reinstall must reactivate the existing account installation'
    )
    await invoke(control, latest)
    assert.equal((await entry(latest)).installed_plugin_id, latest.installedId)
    await openPlugin(control, fixtures.disabled)
    await refreshPluginInventory(control, workbenchReadyTimeoutMs)
    await verifyPluginEnabledState(control, fixtures.disabled, false, workbenchReadyTimeoutMs)
    await captureScreenshot(control, `legacy-${release.version}-reinstalled.png`, 'body')
  }

  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    setRestartDesktopApp(value) {
      restart = value
    },
    async prepareApp({ appBinary, appEnvironment, codexHome }) {
      seedConfig = join(codexHome, 'config.toml')
      pluginTools = await prepareHistoricalPluginTools(join(resultDir, 'historical-plugin-tools'))
      const delivered = await historicalPluginPackages(
        HISTORICAL_PLUGIN_UPDATE,
        join(resultDir, 'historical-plugins', HISTORICAL_PLUGIN_UPDATE.version)
      )
      updatePackages = delivered.packages
      evidence.push({ phase: 'delivered-plugin-update', ...delivered.evidence })
      const script =
        "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).weworkExecutorNamespace || ''))"
      const { stdout } = await promisify(execFile)(
        appBinary,
        ['-e', script, join(packagedResourcesRoot(appBinary), 'app.asar/package.json')],
        { env: { ...appEnvironment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000 }
      )
      namespace = JSON.parse(stdout)
      current = await seed(LEGACY_PLUGIN_RELEASES[0])
      Object.assign(appEnvironment, environment(current.release))
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const id = `legacy-model-${Date.now()}`
      const result = active ? accountCommandResult(body.input, active.id) : null
      let events
      if (result?.sessionId)
        events = shellCommandPollResponse(body, result.pollId, result.sessionId)
      else if (result) {
        active.output = result.output
        assert.match(result.output, /Process exited with code 0\b|"exit_code"\s*:\s*0\b/)
        assert.ok(
          result.output.includes('"nodeSupported": true'),
          'Historical plugin requires supported Node.js'
        )
        assert.ok(result.output.includes(active.expected), 'Migrated plugin command failed')
        events = [assistantMessage(`${active.id} completed`)]
      } else if (active && JSON.stringify(body.input ?? '').includes(active.prompt)) {
        assert.ok(requestAdvertisesShellCommand(body))
        assert.ok(
          requestContainsSkillLocator(body, active.skillPath, active.skillName),
          'Codex did not discover the historical plugin in its migrated native runtime'
        )
        events = shellCommandResponse(body, active.id, active.command, workspacePath)
      } else events = [assistantMessage('Legacy plugin migration fixture ready')]
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
        await verifyBaseline(control)
        const release = LEGACY_PLUGIN_RELEASES[1]
        await restart({
          afterStop: async () => {
            current = await seed(release)
          },
          appEnvironmentOverrides: environment(release),
        })
        await verifyBaseline(control)
      } finally {
        await writeFile(
          join(resultDir, 'legacy-plugin-upgrade.json'),
          JSON.stringify(evidence, null, 2)
        )
      }
    },
  }
}
