import {
  assertMentionRenderedAsToken,
  closeComposerPluginPicker,
  waitForInstalledComposerPlugin,
  waitForSnapshot,
} from './conversation-layout.mjs'

import { sendPrompt } from './conversation-navigation.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  CONNECTOR_AUTH_MARKER_NAME,
  CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
  CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_PROVIDER_ID,
  OFFICIAL_PLUGIN_COMPLETION_TEXT,
  OFFICIAL_PLUGIN_DISPLAY_NAME,
  OFFICIAL_PLUGIN_MARKETPLACE_NAME,
  OFFICIAL_PLUGIN_NAME,
  OFFICIAL_PLUGIN_REPOSITORY_PREFIX,
  OFFICIAL_PLUGIN_REVISION,
  OFFICIAL_PLUGIN_SKILL_MARKER,
  OFFICIAL_PLUGIN_SKILL_NAME,
  OFFICIAL_PLUGIN_SKILL_READY_TEXT,
  PLUGIN_CREATOR_COMPLETION_TEXT,
  PLUGIN_CREATOR_PROMPT,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_MARKETPLACE_NAME,
  PLUGIN_NAME,
  QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
  QUALIFIED_SKILL_MENTION_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  commandOutput,
  createSingleRootLocalProject,
  findFileBySuffix,
  join,
  mkdir,
  pathExists,
  readFile,
  rm,
  selectE2EModel,
  writeFile,
} from './shared.mjs'

import {
  captureVerificationScreenshot,
  currentRuntimeTaskFromDebugSnapshot,
  waitForControlValueIncludes,
  waitForWorkbenchDebugState,
} from './workspace-flows.mjs'
import { createZipFixture } from './zip-fixtures.mjs'

async function createDirectRemoteMcpPluginZip(root) {
  const archivePath = join(root, 'direct-remote-mcp-plugin.zip')
  await createZipFixture(archivePath, {
    '.codex-plugin/plugin.json': JSON.stringify({
      name: 'direct-remote-mcp-plugin',
      version: '1.0.0',
      description: 'Desktop E2E direct remote MCP plugin',
      author: { name: 'Wework Desktop E2E' },
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Direct Remote MCP Plugin',
        shortDescription: 'Exercises direct remote MCP parsing',
        longDescription: 'Exercises direct remote MCP parsing in the native import preview.',
        developerName: 'Wework Desktop E2E',
        category: 'Developer Tools',
        capabilities: ['MCP'],
        defaultPrompt: 'Use the remote MCP server.',
      },
    }),
    '.mcp.json': JSON.stringify({
      remote: {
        url: 'https://mcp.example.com/mcp',
      },
    }),
    'skills/direct-remote/SKILL.md':
      '---\nname: direct-remote\ndescription: Exercise direct remote MCP parsing.\n---\n',
  })
  return archivePath
}

async function createCoreDshPluginFixture(root) {
  const pluginRoot = join(root, 'core-dsh-e2e-plugin')
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(
    join(pluginRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-core-e2e-plugin',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        displayName: 'Wework E2E Plugin',
        description: 'Wework plugin management fixture',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(pluginRoot, 'cordis.patch.yml'),
    "- insert:\n    - id: core-dsh-e2e-plugin\n      name: 'dsh-core-e2e-plugin'\n"
  )
  await writeFile(
    join(pluginRoot, 'index.js'),
    "export const name = 'core-dsh-e2e-plugin'\nexport function apply() {}\n"
  )
  return pluginRoot
}

async function verifyCoreDshPluginManagement({
  control,
  pluginRoot,
  restartDesktopApp,
  userDataDirectory,
}) {
  const manifestPath = join(
    userDataDirectory,
    'dsh-core',
    'profiles',
    'wework-core',
    'package.json'
  )
  const openManager = async () => {
    await control.command('waitFor', '[data-testid="plugins-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="plugins-button"]')
    await control.command('waitFor', '[data-testid="plugins-workspace"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="plugins-manage-button"]')
    await control.command('waitFor', '[data-testid="plugin-management-page-content"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="plugin-management-surface-core-dsh"]')
    await control.command('waitFor', '[data-testid="core-dsh-plugin-management"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  const manifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'))

  await openManager()
  await control.command('fill', '[data-testid="core-dsh-plugin-spec-input"]', {
    value: pluginRoot,
  })
  await control.command('click', '[data-testid="core-dsh-plugin-install-button"]')
  await control.command('click', '[data-testid="core-dsh-plugin-install-confirm"]')
  await control.command('waitFor', '[data-testid="core-dsh-plugin-row-dsh-core-e2e-plugin"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal((await manifest()).dependencies['dsh-core-e2e-plugin'] !== undefined, true)
  assert.equal((await manifest()).dsh.profile.bundles.includes('dsh-core-e2e-plugin'), true)

  await control.command('click', '[data-testid="core-dsh-plugin-toggle-dsh-core-e2e-plugin"]')
  await waitForSnapshot(
    control,
    snapshot => /Disabled|已停用/.test(snapshot.text),
    'The Core DSH plugin did not finish disabling',
    WORKBENCH_READY_TIMEOUT_MS,
    '[data-testid="core-dsh-plugin-row-dsh-core-e2e-plugin"]'
  )
  assert.equal((await manifest()).dsh.profile.bundles.includes('dsh-core-e2e-plugin'), false)

  await restartDesktopApp()
  await openManager()
  await control.command('waitFor', '[data-testid="core-dsh-plugin-row-dsh-core-e2e-plugin"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => /Disabled|已停用/.test(snapshot.text),
    'The disabled Core DSH plugin did not remain disabled after restart',
    WORKBENCH_READY_TIMEOUT_MS,
    '[data-testid="core-dsh-plugin-row-dsh-core-e2e-plugin"]'
  )
  assert.equal((await manifest()).dsh.profile.bundles.includes('dsh-core-e2e-plugin'), false)
  await control.command('click', '[data-testid="core-dsh-plugin-toggle-dsh-core-e2e-plugin"]')
  await waitForSnapshot(
    control,
    snapshot => /Enabled|已启用/.test(snapshot.text),
    'The Core DSH plugin did not finish enabling',
    WORKBENCH_READY_TIMEOUT_MS,
    '[data-testid="core-dsh-plugin-row-dsh-core-e2e-plugin"]'
  )
  assert.equal((await manifest()).dsh.profile.bundles.includes('dsh-core-e2e-plugin'), true)

  await control.command('click', '[data-testid="core-dsh-plugin-uninstall-dsh-core-e2e-plugin"]')
  await control.command('click', '[data-testid="core-dsh-plugin-uninstall-confirm"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('core-dsh-plugin-row-dsh-core-e2e-plugin'),
    'The uninstalled Core DSH plugin remained in the management list',
    WORKBENCH_READY_TIMEOUT_MS
  )
  assert.equal((await manifest()).dependencies['dsh-core-e2e-plugin'], undefined)
  assert.equal((await manifest()).dsh.profile.bundles.includes('dsh-core-e2e-plugin'), false)

  await restartDesktopApp()
  await openManager()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('core-dsh-plugin-row-dsh-core-e2e-plugin'),
    'The uninstalled Core DSH plugin returned after restart',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await control.command('navigate', 'body', { value: '/' })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('projects-empty-create-button') ||
      snapshot.testIds.includes('runtime-project-sortable-list'),
    'The workbench did not recover after the Core DSH plugin management flow',
    WORKBENCH_READY_TIMEOUT_MS
  )
}

async function verifyCloudWorkPage(control) {
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', '[data-testid="cloud-work-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    snapshot.testIds.includes('cloud-work-devices-section'),
    'The cloud work page did not render its device status section'
  )
  assert.ok(
    snapshot.testIds.includes('cloud-work-projects-section'),
    'The cloud work page did not render its cloud projects section'
  )
  assert.equal(
    snapshot.testIds.includes('general-settings-page'),
    false,
    'The cloud work route unexpectedly opened general settings'
  )
  await captureVerificationScreenshot(control, '00-cloud-work-page.png')
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function initializeBlankCodexHome({ codexHome, control }) {
  const configPath = join(codexHome, 'config.toml')
  await control.command('waitFor', '[data-testid="codex-home-initializer-dialog"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'plugins-00-blank-codex-home.png')
  await control.command('click', '[data-testid="codex-home-initializer-create-button"]')
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    (await readFile(configPath, 'utf8')).includes('desktop-e2e-native-home-marker'),
    false,
    'Creating a blank Codex home unexpectedly migrated native Codex content'
  )
}

async function waitForBundledMarketplaceRegistration(codexHome) {
  const configPath = join(codexHome, 'config.toml')
  const startedAt = Date.now()
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    if (await pathExists(configPath)) {
      const config = await readFile(configPath, 'utf8')
      if (
        config.includes('[marketplaces.wework-personal]') &&
        config.includes('source_type = "local"')
      ) {
        return
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error('The bundled local plugin marketplace was not registered in the background')
}

async function verifyStartupIgnoresBlockedCodexNetwork({
  blockingNetworkProxy,
  configureCodex,
  control,
  restartDesktopApp,
}) {
  const modelRequestCountBeforeRestart = control.modelRequests.length
  await control.command('storeLocalProxyUrl', 'body', { value: blockingNetworkProxy.url })
  await restartDesktopApp({ afterStop: configureCodex })
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    snapshot.testIds.includes('desktop-workbench-main'),
    'Blocked Codex network traffic prevented the workbench from becoming usable'
  )
  const executorStatus = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.equal(
    executorStatus.ready,
    true,
    'The local executor was not ready when the workbench became usable'
  )
  console.log('Workbench became usable without waiting for blocked Codex network traffic')
  assert.equal(
    control.modelRequests.length,
    modelRequestCountBeforeRestart,
    'The workbench sent an agent model request while Codex was still starting'
  )

  blockingNetworkProxy.release()
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('setLocalProxyUrl', 'body', { value: '' })
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function verifyOfficialPluginSource(repositoryRoot) {
  const officialPluginRoot = join(repositoryRoot, 'plugins', OFFICIAL_PLUGIN_NAME)
  const officialPluginManifestPath = join(officialPluginRoot, '.codex-plugin', 'plugin.json')
  const officialPluginMcpPath = join(officialPluginRoot, '.mcp.json')
  const officialPluginSkillPath = join(
    officialPluginRoot,
    'skills',
    OFFICIAL_PLUGIN_SKILL_NAME,
    'SKILL.md'
  )
  const [pluginManifest, mcpManifest, skill] = await Promise.all([
    readFile(officialPluginManifestPath, 'utf8').then(JSON.parse),
    readFile(officialPluginMcpPath, 'utf8').then(JSON.parse),
    readFile(officialPluginSkillPath, 'utf8'),
  ])

  assert.equal(
    commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    OFFICIAL_PLUGIN_REVISION
  )
  assert.equal(pluginManifest.name, OFFICIAL_PLUGIN_NAME)
  assert.equal(pluginManifest.author?.name, 'OpenAI')
  assert.ok(
    pluginManifest.repository?.startsWith(OFFICIAL_PLUGIN_REPOSITORY_PREFIX),
    'The synced plugin manifest did not point to the official OpenAI plugin repository'
  )
  assert.equal(pluginManifest.skills, './skills/')
  assert.equal(pluginManifest.mcpServers, './.mcp.json')
  assert.ok(skill.includes(OFFICIAL_PLUGIN_SKILL_MARKER))
  assert.ok(
    Object.keys(mcpManifest.mcpServers ?? {}).includes('openai-api-key-local-confirmation'),
    'The official plugin did not declare its local MCP server'
  )
}

async function openMarketplacePluginActions(control, { pluginId, marketplaceName, displayName }) {
  const actionsSelector = `[data-testid="plugin-marketplace-actions-${pluginId}"]`
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  const marketplaceTabSelector = `[data-testid="plugins-marketplace-tab-${marketplaceName}"]`
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (snapshot.testIds.includes('plugins-clear-marketplace-filters')) {
    await control.command('click', '[data-testid="plugins-clear-marketplace-filters"]')
  } else if (snapshot.testIds.includes('plugins-search-input')) {
    await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })
  }
  await control.command('waitFor', marketplaceTabSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', marketplaceTabSelector)
  await control.command('fill', '[data-testid="plugins-search-input"]', {
    value: displayName,
  })
  await control.command('waitFor', actionsSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const actionsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!actionsSnapshot.testIds.includes(`plugin-marketplace-try-${pluginId}`)) {
    await control.command('click', actionsSelector)
  }
  await control.command('waitFor', trySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function installOfficialPluginFixture({
  codexHome,
  control,
  marketplacePath,
  modelServerUrl,
  repositoryPath,
  workspacePath,
}) {
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await verifyOfficialPluginSource(repositoryPath)

  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })

  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (initialSnapshot.testIds.includes('plugins-add-custom-marketplace-empty-button')) {
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-empty-button"]')
  } else if (initialSnapshot.testIds.includes('plugins-add-marketplace-button')) {
    await control.command('click', '[data-testid="plugins-add-marketplace-button"]')
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-button"]')
  } else {
    await control.command('click', '[data-testid="plugins-create-button"]')
    await control.command('click', '[data-testid="plugins-add-market-option"]')
  }
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', {
    value: OFFICIAL_PLUGIN_DISPLAY_NAME,
  })

  const pluginId = `${OFFICIAL_PLUGIN_MARKETPLACE_NAME}:${OFFICIAL_PLUGIN_NAME}@${OFFICIAL_PLUGIN_MARKETPLACE_NAME}`
  const rowTestId = `plugin-marketplace-row-${pluginId}`
  const installTestId = `plugin-marketplace-install-${pluginId}`
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('plugins-marketplace-dialog') &&
      snapshot.testIds.includes(rowTestId) &&
      snapshot.testIds.includes(installTestId),
    'The pinned OpenAI marketplace did not become installable',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'plugins-01-marketplace.png')

  await control.command('click', installSelector)
  await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(`plugins-installed-strip-item-${pluginId}`) ||
      snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The official plugin was not shown as installed after the real app-server request',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await openMarketplacePluginActions(control, {
    pluginId,
    marketplaceName: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
    displayName: OFFICIAL_PLUGIN_DISPLAY_NAME,
  })
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  assert.match(
    await control.command('getText', trySelector),
    /Try in chat|Start chat|在对话中试用|立即对话/,
    'The installed plugin did not expose its chat action'
  )
  await captureVerificationScreenshot(control, 'plugins-02-installed.png')

  const skillPath = await findFileBySuffix(
    join(codexHome, 'plugins', 'cache', OFFICIAL_PLUGIN_MARKETPLACE_NAME),
    join('skills', OFFICIAL_PLUGIN_SKILL_NAME, 'SKILL.md')
  )
  assert.ok(skillPath, 'The official plugin skill was not materialized in the isolated Codex home')
  assert.ok(
    skillPath.includes(`${OFFICIAL_PLUGIN_NAME}/`),
    'The discovered skill did not belong to the installed official plugin'
  )
  assert.ok(
    (await readFile(skillPath, 'utf8')).includes(OFFICIAL_PLUGIN_SKILL_MARKER),
    'The materialized official skill did not match the pinned OpenAI plugin content'
  )
  const codexConfig = await readFile(join(codexHome, 'config.toml'), 'utf8')
  assert.ok(
    codexConfig.includes(`model_provider = "${MODEL_PROVIDER_ID}"`) &&
      codexConfig.includes(`base_url = "${modelServerUrl}/v1"`),
    'Installing the official plugin discarded the isolated E2E model provider'
  )

  return { installSelector, pluginId, skillPath }
}

async function openOfficialPluginChat(control, installSelector) {
  const pluginId = installSelector
    .replace(/^\[data-testid="plugin-marketplace-install-/, '')
    .replace(/"\]$/, '')
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  const detailTrySelector = `[data-testid="plugin-detail-toggle-${pluginId}"]`
  const installedStripSelector = `[data-testid="plugins-installed-strip-item-${pluginId}"]`
  const activeTabSelector = '[data-testid^="workspace-tab-select-"][aria-selected="true"]'
  const activeTabTestId = await control.command('getAttribute', activeTabSelector, {
    value: 'data-testid',
  })
  assert.ok(activeTabTestId, 'The plugin trial did not expose its active workspace tab')
  const activeTabId = activeTabTestId.replace('workspace-tab-select-', '')
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  await control.command(
    'waitFor',
    '[data-testid^="workspace-tab-select-task-"][aria-selected="true"]',
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${activeTabId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-${activeTabId}"][aria-selected="true"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const pluginsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (pluginsSnapshot.testIds.includes(`plugins-installed-strip-item-${pluginId}`)) {
    await control.command('click', installedStripSelector)
    await control.command('waitFor', detailTrySelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    assert.match(
      await control.command('getText', detailTrySelector),
      /Try in chat|Start chat|在对话中试用|立即对话/,
      'The installed official plugin detail did not expose its chat action'
    )
    await control.command('click', detailTrySelector)
  } else {
    await openMarketplacePluginActions(control, {
      pluginId,
      marketplaceName: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
      displayName: OFFICIAL_PLUGIN_DISPLAY_NAME,
    })
    await control.command('click', trySelector)
  }
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(OFFICIAL_PLUGIN_DISPLAY_NAME),
    'Trying the installed official plugin did not place its reference in the composer',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function createOfficialPluginTask({ control, installSelector, skillPath }) {
  await openOfficialPluginChat(control, installSelector)
  await captureVerificationScreenshot(control, 'plugins-03-used-in-chat.png')
  control.officialPluginSkillPath = skillPath
  control.scenarioRequests.delete('official_plugin')
  control.setScenario('official_plugin')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: OFFICIAL_PLUGIN_SKILL_READY_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await assertMentionRenderedAsToken(control, {
    tokenSelector: '[data-testid="sent-plugin-token-OpenAI-Developers"]',
    tokenText: OFFICIAL_PLUGIN_DISPLAY_NAME,
    plainTextMention: `@${OFFICIAL_PLUGIN_NAME}`,
    errorLabel: 'The sent plugin reference degraded to its plain-text mention',
  })
  await control.awaitScenarioRequestCount('official_plugin', 2, WORKBENCH_READY_TIMEOUT_MS)
  const taskSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot => Boolean(currentRuntimeTaskFromDebugSnapshot(snapshot)?.taskId),
    'The official plugin conversation did not expose its task ID'
  )
  return currentRuntimeTaskFromDebugSnapshot(taskSnapshot).taskId
}

async function verifyPluginLifecycle({ control, fixture }) {
  await createOfficialPluginTask({
    control,
    installSelector: fixture.installSelector,
    skillPath: fixture.skillPath,
  })
  await sendPrompt(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    'Call the selected official plugin MCP server to validate an out-of-workspace env path.'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: OFFICIAL_PLUGIN_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('official_plugin', 5, WORKBENCH_READY_TIMEOUT_MS)
  assert.equal(
    control.scenarioRequests.get('official_plugin')?.length,
    5,
    'The official plugin flow did not execute the expected skill-read, tool-search, and MCP-call turns'
  )
  await captureVerificationScreenshot(control, 'plugins-04-skill-and-mcp-complete.png')
}

async function waitForMarketplaceInstallStateAfterUninstall(control, pluginId) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The plugin remained installed after the uninstall request'
  )
  // Uninstalling bumps the marketplace refresh tick, which temporarily replaces
  // the catalog rows with a loading state, so poll until the install action
  // settles back instead of asserting against the transient refresh UI.
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  const startedAt = Date.now()
  let lastActionText = ''
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    lastActionText = await control.command('getText', installSelector)
    if (/Install|安装/.test(lastActionText)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(
    `The marketplace did not return to the install state after uninstall; last install action text: ${JSON.stringify(lastActionText)}`
  )
}

async function verifyMarketplacePluginLifecycle({
  blockingNetworkProxy,
  codexHome,
  control,
  executorHome,
  marketplacePath,
  workspacePath,
}) {
  let bootstrap = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  if (!bootstrap.workbench?.currentProject?.id) {
    await control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await createSingleRootLocalProject(control, workspacePath, 'marketplace-plugin')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    bootstrap = await waitForWorkbenchDebugState(
      control,
      snapshot => Boolean(snapshot.workbench?.currentProject?.id),
      'Creating a local project did not open an active marketplace project'
    )
  }

  const activeTaskBeforePluginTrial = bootstrap
  let activeTaskId = activeTaskBeforePluginTrial.workbench.currentRuntimeTask?.taskId ?? null
  const activeProjectId = activeTaskBeforePluginTrial.workbench.currentProject?.id
  assert.ok(activeProjectId, 'The marketplace plugin lifecycle requires an active project')

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })

  await control.command('click', '[data-testid="plugins-create-button"]')
  await control.command('click', '[data-testid="plugins-import-plugin-option"]')
  await control.command('waitFor', '[data-testid="plugin-import-dialog"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const importSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    importSnapshot.testIds.includes('plugin-import-select') &&
      importSnapshot.testIds.includes('plugin-import-download-example'),
    'The plugin import dialog did not expose package selection and the example download'
  )
  assert.ok(
    importSnapshot.text.includes('.codex-plugin/plugin.json') &&
      importSnapshot.text.includes('skills/<slug>/SKILL.md'),
    'The plugin import dialog did not explain the standard Wework plugin package structure'
  )
  const archivePath = await createDirectRemoteMcpPluginZip(marketplacePath)
  const personalMarketplacePath = join(
    executorHome,
    'capabilities/bundled-marketplaces/wework-personal'
  )
  const preview = JSON.parse(
    await control.command('previewPluginImport', 'body', {
      value: JSON.stringify({ archivePath, marketplacePath }),
    })
  )
  assert.equal(preview.valid, true, `Direct remote MCP plugin was rejected: ${preview.issues}`)
  assert.equal(preview.mcpServerCount, 1)
  assert.equal(preview.name, 'direct-remote-mcp-plugin')
  await captureVerificationScreenshot(control, 'marketplace-plugins-00-import.png')
  await control.command('click', '[data-testid="plugin-import-close"]')

  blockingNetworkProxy.block()
  const blockedRequestCount = blockingNetworkProxy.requests.length
  const importStartedAt = Date.now()
  try {
    await control.command('setLocalProxyUrl', 'body', { value: blockingNetworkProxy.url })
    const imported = JSON.parse(
      await control.command('importPluginPackage', 'body', {
        value: JSON.stringify({ preview, overwrite: false }),
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
    )
    const importElapsedMs = Date.now() - importStartedAt
    assert.equal(imported.pluginName, 'direct-remote-mcp-plugin')
    assert.ok(
      importElapsedMs <= DEFAULT_STEP_TIMEOUT_MS,
      `Local plugin import waited ${importElapsedMs}ms for blocked post-install network work`
    )
    assert.equal(
      await pathExists(
        join(
          codexHome,
          'plugins/cache/wework-personal/direct-remote-mcp-plugin/1.0.0/.codex-plugin/plugin.json'
        )
      ),
      true,
      'The offline import returned before the local plugin cache was committed'
    )
    const codexConfigAfterImport = await readFile(join(codexHome, 'config.toml'), 'utf8')
    assert.ok(
      codexConfigAfterImport.includes('"direct-remote-mcp-plugin@wework-personal"') &&
        codexConfigAfterImport.includes('enabled = true'),
      'The offline import returned before the plugin was enabled in Codex config'
    )
    const deleteStartedAt = Date.now()
    await control.command('deleteLocalPluginPackage', 'body', {
      value: JSON.stringify({
        pluginId: 'direct-remote-mcp-plugin@wework-personal',
        pluginName: 'direct-remote-mcp-plugin',
      }),
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const deleteElapsedMs = Date.now() - deleteStartedAt
    assert.ok(
      deleteElapsedMs <= DEFAULT_STEP_TIMEOUT_MS,
      `Local plugin deletion waited ${deleteElapsedMs}ms for blocked marketplace network work`
    )
    assert.equal(
      await pathExists(join(codexHome, 'plugins/cache/wework-personal/direct-remote-mcp-plugin')),
      false,
      'The offline delete left the local Codex plugin cache behind'
    )
    assert.equal(
      await pathExists(join(personalMarketplacePath, 'plugins/direct-remote-mcp-plugin')),
      false,
      'The offline delete left the personal plugin source behind'
    )
    assert.equal(
      blockingNetworkProxy.requests.length,
      blockedRequestCount,
      'Local plugin import or deletion unexpectedly requested external network access'
    )
  } finally {
    blockingNetworkProxy.release()
    await control.command('setLocalProxyUrl', 'body', { value: '' })
  }

  await control.command('click', '[data-testid="plugins-create-button"]')
  await control.command('waitFor', '[data-testid="plugins-create-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'marketplace-plugins-00-create-menu.png')
  await control.command('click', '[data-testid="plugins-create-plugin-option"]')
  await control.command('waitFor', '[data-testid="plugin-create-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugin-create-workspace') &&
      snapshot.testIds.includes('plugin-creator-context') &&
      snapshot.testIds.includes('project-chat-composer') &&
      snapshot.testIds.includes('composer-toolbar') &&
      snapshot.testIds.includes('attachment-file-input') &&
      snapshot.testIds.includes('model-selector-button') &&
      snapshot.testIds.includes('plugin-create-prompt-input') &&
      snapshot.testIds.includes('plugin-create-submit-button') &&
      snapshot.text.includes('Plugin Creator'),
    'The managed Plugin Creator workspace did not open'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-00-creator.png')
  await control.command('fill', '[data-testid="plugin-create-prompt-input"]', {
    value: PLUGIN_CREATOR_PROMPT,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-create-submit-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const pluginCreatorTask = await waitForWorkbenchDebugState(
    control,
    snapshot => {
      const taskId = snapshot.workbench?.currentRuntimeTask?.taskId
      return Boolean(taskId && taskId !== activeTaskId)
    },
    'Creating a plugin continued the existing conversation instead of opening a new task'
  )
  activeTaskId = pluginCreatorTask.workbench.currentRuntimeTask.taskId
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    text: PLUGIN_CREATOR_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })
  await control.command('click', '[data-testid="plugins-create-button"]')
  await control.command('click', '[data-testid="plugins-add-market-option"]')
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const pluginId = `${PLUGIN_MARKETPLACE_NAME}:${PLUGIN_NAME}@${PLUGIN_MARKETPLACE_NAME}`
  const rowSelector = `[data-testid="plugin-marketplace-row-${pluginId}"]`
  await control.command('waitFor', rowSelector, {
    text: PLUGIN_DISPLAY_NAME,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  const actionsSelector = `[data-testid="plugin-marketplace-actions-${pluginId}"]`
  await captureVerificationScreenshot(control, 'marketplace-plugins-01-marketplace.png')

  await control.command('click', rowSelector)
  await control.command('waitFor', '[data-testid="plugin-detail-get-started"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  // Example cards install (when needed) and open a non-auto-send chat trial — no
  // separate use-case guide dialog remains in the product.
  await control.command('click', '[data-testid="plugin-prompt-0"]')
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugin-trial-template-strip') &&
      snapshot.testIds.includes('plugin-trial-recommendation') &&
      snapshot.text.includes('Verify the Wework desktop plugin lifecycle.'),
    'Clicking a plugin example did not open the non-auto-send trial flow'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-02-example-trial.png')
  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('plugin-trial-template-strip'),
    'Dismissing the plugin trial guide did not close the recommendation strip'
  )

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  // Leaving for the trial chat resets the marketplace tab/filter; restore the
  // fixture market before looking for the plugin row again.
  const returnedSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (returnedSnapshot.testIds.includes('plugins-clear-marketplace-filters')) {
    await control.command('click', '[data-testid="plugins-clear-marketplace-filters"]')
  } else {
    await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })
  }
  await control.command(
    'click',
    `[data-testid="plugins-marketplace-tab-${PLUGIN_MARKETPLACE_NAME}"]`
  )

  // Example click installs before opening trial; only run the install /
  // connector-auth path when the install CTA is still present.
  const afterExampleSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(`plugin-marketplace-install-${pluginId}`) ||
      snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`) ||
      snapshot.testIds.some(
        testId => testId.startsWith('plugins-installed-strip-item-') && testId.includes(PLUGIN_NAME)
      ),
    'Returning to Plugins after the example trial did not show the marketplace plugin'
  )
  if (afterExampleSnapshot.testIds.includes(`plugin-marketplace-install-${pluginId}`)) {
    await control.command('click', installSelector)
    await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]', {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="local-connector-auth-dialog"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="local-connector-auth-browser"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
  const installedSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`) ||
      snapshot.testIds.some(
        testId => testId.startsWith('plugins-installed-strip-item-') && testId.includes(PLUGIN_NAME)
      ),
    'The plugin was not shown as installed after the real app-server request'
  )
  if (!installedSnapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`)) {
    // Install succeeded but the active market/distribution filter hid the card.
    if (installedSnapshot.testIds.includes('plugins-clear-marketplace-filters')) {
      await control.command('click', '[data-testid="plugins-clear-marketplace-filters"]')
    }
    await control.command(
      'click',
      `[data-testid="plugins-marketplace-tab-${PLUGIN_MARKETPLACE_NAME}"]`
    )
    await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
      'The installed plugin card did not reappear under its marketplace tab'
    )
  }
  await control.command('waitFor', actionsSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`) &&
      snapshot.testIds.some(
        testId => testId.startsWith('plugins-installed-strip-item-') && testId.includes(PLUGIN_NAME)
      ),
    'The installed marketplace card and installed strip became inconsistent'
  )
  await control.command('click', actionsSelector)
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  await control.command('waitFor', trySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', trySelector),
    /Start chat|立即对话/,
    'The installed plugin did not expose its chat action'
  )
  const manageSelector = `[data-testid="plugin-marketplace-manage-${pluginId}"]`
  await control.command('waitFor', manageSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', manageSelector)
  await control.command('waitFor', '[data-testid="plugin-detail-back-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const manageOpenedDetail = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    manageOpenedDetail.testIds.includes('plugin-management-page-content'),
    false,
    'Marketplace manage opened the management list instead of the plugin detail'
  )
  const detailActionMenuSelector =
    '[data-testid^="plugin-detail-actions-"]:not([data-testid="plugin-detail-actions-bar"])'
  const detailPrimaryActionSelector = '[data-testid^="plugin-detail-toggle-"]'
  await control.command('waitFor', detailActionMenuSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', detailPrimaryActionSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const [detailActionMenuMetrics] = JSON.parse(
    await control.command('getElementMetrics', detailActionMenuSelector)
  )
  const [detailPrimaryActionMetrics] = JSON.parse(
    await control.command('getElementMetrics', detailPrimaryActionSelector)
  )
  assert.ok(
    detailActionMenuMetrics.right <= detailPrimaryActionMetrics.left,
    'The plugin detail overflow menu was not placed before the primary action'
  )
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  await control.command('waitFor', actionsSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', actionsSelector)
  await control.command('waitFor', trySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'marketplace-plugins-03-installed.png')

  await control.command('click', actionsSelector)
  await control.command('click', rowSelector)
  const detailActionSelector = '[data-testid^="plugin-detail-toggle-"]'
  await control.command('waitFor', detailActionSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', detailActionSelector),
    /Start chat|立即对话/,
    'The plugin detail did not expose its new-chat action'
  )
  await control.command('click', detailActionSelector)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(PLUGIN_DISPLAY_NAME),
    'Trying the installed plugin did not place its reference in the composer',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask === null &&
      snapshot.workbench?.currentProject?.id === activeProjectId,
    'Starting a plugin chat did not open a new conversation under the active project'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugin-trial-template-strip') &&
      snapshot.testIds.includes('plugin-trial-ai-refine') &&
      snapshot.text.includes(PLUGIN_DISPLAY_NAME),
    'Trying the installed plugin did not expose its AI usage guide'
  )
  await control.command('click', '[data-testid="plugin-trial-ai-refine"]')
  await control.command('waitFor', '[data-testid="plugin-trial-ai-result"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const refinedPluginSuggestion = await control.command(
    'getText',
    '[data-testid="plugin-trial-recommendation-title"]'
  )
  assert.ok(refinedPluginSuggestion.trim(), 'AI did not return a plugin task suggestion')
  await control.command('click', '[data-testid="plugin-trial-recommendation-apply"]')
  await waitForControlValueIncludes(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    refinedPluginSuggestion,
    'The AI-refined plugin task was not applied to the composer'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-04-used-in-chat.png')

  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('plugin-trial-template-strip'),
    'Dismissing the plugin trial guide did not close the recommendation strip'
  )
  const composerPluginItemTestId = await waitForInstalledComposerPlugin(control, {
    pluginName: PLUGIN_NAME,
    pluginDisplayName: PLUGIN_DISPLAY_NAME,
  })
  const composerPluginSelector = `[data-testid="${composerPluginItemTestId}"]`
  await control.command('click', composerPluginSelector)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes('plugin-trial-template-strip'),
    'Selecting the installed plugin from the composer did not expose its templates'
  )

  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '/desktop' })
  const slashPluginSelector = `[data-testid="slash-command-option-app-plugin-${PLUGIN_NAME}"]`
  await control.command('waitFor', slashPluginSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', slashPluginSelector)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes('plugin-trial-template-strip'),
    'Selecting the installed plugin from slash commands did not expose its templates'
  )

  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await rm(join(executorHome, CONNECTOR_AUTH_MARKER_NAME), { force: true })
  control.scenarioRequests.delete('connector_auth_unmatched_resume')
  control.setScenario('connector_auth_unmatched_resume')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
    value: CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  })
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
  const unmatchedResumeSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !unmatchedResumeSnapshot.testIds.includes('connector-auth-card'),
    'Unmatched connector auth resume incorrectly showed the chat auth card'
  )
  assert.ok(
    !unmatchedResumeSnapshot.testIds.includes('local-connector-auth-dialog'),
    'Unmatched connector auth resume incorrectly showed the install auth dialog'
  )
  await captureVerificationScreenshot(
    control,
    'marketplace-plugins-05b-unmatched-resume-no-auth-card.png'
  )

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'click',
    `[data-testid="plugins-marketplace-tab-${PLUGIN_MARKETPLACE_NAME}"]`
  )
  await control.command('waitFor', actionsSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const uninstallSelector = `[data-testid="plugin-marketplace-uninstall-${pluginId}"]`
  await control.command('click', actionsSelector)
  await control.command('waitFor', uninstallSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', uninstallSelector)
  await control.command('waitFor', '[data-testid="plugin-uninstall-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-uninstall-confirm-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForMarketplaceInstallStateAfterUninstall(control, pluginId)
  await captureVerificationScreenshot(control, 'marketplace-plugins-05-uninstalled.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  await control.command('waitFor', '[data-testid="composer-plugin-picker"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const composerAfterUninstall = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !composerAfterUninstall.testIds.includes(`composer-plugin-picker-item-plugin:${PLUGIN_NAME}`),
    'The uninstalled marketplace plugin remained available in the composer plugin picker'
  )
  await captureVerificationScreenshot(
    control,
    'marketplace-plugins-06-composer-after-uninstall.png'
  )
  // Leave chat with a closed picker so the official-plugin install segment does
  // not inherit an open composer menu from this assertion.
  await closeComposerPluginPicker(control)
}

async function verifySkillMentionRendering({ control, fixture }) {
  const officialPluginTaskId = await createOfficialPluginTask({
    control,
    installSelector: fixture.installSelector,
    skillPath: fixture.skillPath,
  })
  const qualifiedSkillName = `${OFFICIAL_PLUGIN_NAME}:${OFFICIAL_PLUGIN_SKILL_NAME}`
  const qualifiedSkillTestId = qualifiedSkillName.replace(/[^a-zA-Z0-9_-]/g, '-')
  await control.command('click', '[data-testid="new-chat-button"]')
  control.setScenario('skill_mention_display')
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
    value: `[$${qualifiedSkillName}](${fixture.skillPath}) ${QUALIFIED_SKILL_MENTION_PROMPT}`,
  })
  await control.command('waitFor', `[data-testid="local-skill-chip-${qualifiedSkillTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const qualifiedSkillTaskSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot => Boolean(currentRuntimeTaskFromDebugSnapshot(snapshot)?.taskId),
    'The qualified skill conversation did not expose its task ID'
  )
  const qualifiedSkillTaskId = currentRuntimeTaskFromDebugSnapshot(
    qualifiedSkillTaskSnapshot
  ).taskId
  const officialPluginTaskRow = `[data-testid="runtime-local-task-row-${officialPluginTaskId}"]`
  const qualifiedSkillTaskRow = `[data-testid="runtime-local-task-row-${qualifiedSkillTaskId}"]`
  await control.command('waitFor', officialPluginTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', qualifiedSkillTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', officialPluginTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: OFFICIAL_PLUGIN_SKILL_READY_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await assertMentionRenderedAsToken(control, {
    tokenSelector: '[data-testid="sent-plugin-token-OpenAI-Developers"]',
    tokenText: OFFICIAL_PLUGIN_DISPLAY_NAME,
    plainTextMention: `@${OFFICIAL_PLUGIN_NAME}`,
    errorLabel: 'The reopened plugin reference degraded to its plain-text mention',
  })
  await control.command('clickWhenEnabled', qualifiedSkillTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await assertMentionRenderedAsToken(control, {
    tokenSelector: `[data-testid="sent-local-skill-token-${qualifiedSkillTestId}"]`,
    plainTextMention: `$${qualifiedSkillName}`,
    errorLabel: 'The reloaded qualified skill reference degraded to its plain-text mention',
  })
  await captureVerificationScreenshot(control, 'skill-mention-01-reloaded.png')
}

async function uninstallOfficialPlugin(control, fixture) {
  await control.command('click', '[data-testid="plugins-button"]')
  const pluginsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (pluginsSnapshot.testIds.includes('plugin-detail-back-button')) {
    await control.command('click', '[data-testid="plugin-detail-back-button"]')
  }
  await openMarketplacePluginActions(control, {
    pluginId: fixture.pluginId,
    marketplaceName: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
    displayName: OFFICIAL_PLUGIN_DISPLAY_NAME,
  })
  const uninstallSelector = `[data-testid="plugin-marketplace-uninstall-${fixture.pluginId}"]`
  await control.command('waitFor', uninstallSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', uninstallSelector)
  await control.command('waitFor', '[data-testid="plugin-uninstall-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-uninstall-confirm-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForMarketplaceInstallStateAfterUninstall(control, fixture.pluginId)
  await captureVerificationScreenshot(control, 'plugins-05-uninstalled.png')
}

export {
  createCoreDshPluginFixture,
  verifyCloudWorkPage,
  initializeBlankCodexHome,
  waitForBundledMarketplaceRegistration,
  verifyStartupIgnoresBlockedCodexNetwork,
  verifyOfficialPluginSource,
  openMarketplacePluginActions,
  installOfficialPluginFixture,
  openOfficialPluginChat,
  createOfficialPluginTask,
  verifyPluginLifecycle,
  waitForMarketplaceInstallStateAfterUninstall,
  verifyMarketplacePluginLifecycle,
  verifySkillMentionRendering,
  uninstallOfficialPlugin,
  verifyCoreDshPluginManagement,
}
