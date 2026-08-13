import {
  closeBottomWorkspacePanel,
  openBottomWorkspaceTerminal,
  prepareCompletedTurnScreenshot,
  waitForSnapshot,
} from './conversation-layout.mjs'

import {
  sendPrompt,
  sendPromptWithButton,
  verifyMultimodalVision,
  verifyVisionSidecar,
} from './conversation-navigation.mjs'

import { waitForScenarioRequestCount } from './memory-tool-flows.mjs'

import { verifyActiveGoalIdleUnreadLifecycle, verifyBusyTurnGoalHandoff } from './goal-flows.mjs'

import { verifyAnthropicEmptyResponseRecovery } from './resilience-flows.mjs'

import {
  matrixArtifact,
  matrixArtifactContent,
  matrixCaseId,
  matrixTextCompletion,
  matrixTextPrompt,
  matrixToolCompletion,
  matrixToolPrompt,
} from './response-protocol.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_ARTIFACT_CONTENT,
  CLOUD_ARTIFACT_NAME,
  CLOUD_COMPLETION_TEXT,
  CLOUD_DEVICE_ID,
  CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
  CLOUD_MULTIMODAL_VISION_CASE,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_FEATURES_ONLY,
  CLOUD_ONLY,
  CLOUD_TASK_PROMPT,
  CLOUD_VISION_SIDECAR_CASE,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  E2E_TRANSCRIPT_PAGE_SIZE,
  LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
  MACOS_LAUNCH_SERVICES_REGISTER,
  MEMORY_ONLY,
  MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  MODEL_PROTOCOL_MATRIX_TOTAL,
  MODEL_PROVIDER_ID,
  RETRY_CODEX_ERROR_TEXT,
  RETRY_COMPLETION_TEXT,
  RETRY_PROMPT,
  RUNS_PLUGIN_E2E,
  RESTART_RECONCILE_TIMEOUT_MS,
  TELEMETRY_TEST_PROJECT_KEY,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  chmod,
  commandOutput,
  confirmLocalProjectName,
  copyFile,
  createSingleRootLocalProject,
  dirname,
  isExecutable,
  join,
  mkdir,
  randomUUID,
  readFile,
  rename,
  repoDir,
  resolve,
  resolveExecutable,
  resultDir,
  runChecked,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  symlink,
  toolDetailsMcpServerPath,
  weworkDir,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { waitForTaskRowByText } from './task-state-flows.mjs'

import {
  captureVerificationScreenshot,
  waitForControlValue,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForWorkbenchTask,
} from './workspace-flows.mjs'

async function waitForSingleProjectByTitle(control, expectedTitle, message, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const projectMenuTestIds = snapshot.testIds.filter(testId => testId.startsWith('project-menu-'))
    if (projectMenuTestIds.length === 1) {
      const projectId = projectMenuTestIds[0].slice('project-menu-'.length)
      try {
        const title = await control.command('getText', `[data-testid="project-title-${projectId}"]`)
        if (title.trim() === expectedTitle) return { projectId, snapshot }
      } catch {
        // The transient project row can disappear between snapshot and lookup.
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function writeCodexConfig(
  codexHome,
  modelServerUrl,
  scenarioConfigToml = '',
  upstreamApiFormat = 'openai-responses'
) {
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const temporaryConfigPath = join(codexHome, `config.toml.${randomUUID()}.tmp`)
  await writeFile(
    temporaryConfigPath,
    `model_provider = "${MODEL_PROVIDER_ID}"\nmodel = "${DEFAULT_MODEL_ID}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n${scenarioConfigToml}\n[model_providers.${MODEL_PROVIDER_ID}]\nname = "Wework Desktop E2E"\nbase_url = "${modelServerUrl}/v1"\nenv_key = "WEWORK_E2E_MODEL_API_KEY"\nwire_api = "responses"\nupstream_api_format = "${upstreamApiFormat}"\n`,
    'utf8'
  )
  await rename(temporaryConfigPath, configPath)
}

function toolDetailsMcpConfigToml() {
  const command = JSON.stringify(process.execPath)
  const server = JSON.stringify(toolDetailsMcpServerPath)
  return [
    '[mcp_servers.node_repl]',
    `command = ${command}`,
    `args = [${server}, "node_repl"]`,
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers."github__issues"]',
    `command = ${command}`,
    `args = [${server}, "github__issues"]`,
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n')
}

function codexUpstreamApiFormat(protocol) {
  return protocol === 'responses'
    ? 'openai-responses'
    : protocol === 'chat'
      ? 'openai-chat-completions'
      : 'anthropic-messages'
}

async function buildExecutor() {
  const configured = process.env.WEWORK_E2E_EXECUTOR_BIN
  if (configured)
    return resolveExecutable(configured, 'wegent-executor', 'Configured Wework executor')

  const targetDir = process.env.WEWORK_E2E_EXECUTOR_TARGET_DIR?.trim()
    ? resolve(repoDir, process.env.WEWORK_E2E_EXECUTOR_TARGET_DIR.trim())
    : join(repoDir, 'executor', 'target', 'desktop-e2e')
  await runChecked('cargo', ['build', '--locked', '--bin', 'wegent-executor'], {
    cwd: join(repoDir, 'executor'),
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  })
  const binaryName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  const binaryPath = join(targetDir, 'debug', binaryName)
  assert.equal(await isExecutable(binaryPath), true, `Executor build did not produce ${binaryPath}`)
  const stagedBinaryPath = join(resultDir, binaryName)
  await copyFile(binaryPath, stagedBinaryPath)
  await chmod(stagedBinaryPath, 0o755)
  return stagedBinaryPath
}

function hostCodexTarget() {
  const targetByPlatformAndArch = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'win32:x64': 'x86_64-pc-windows-msvc',
  }
  const target = targetByPlatformAndArch[`${process.platform}:${process.arch}`]
  assert.ok(target, `Unsupported Codex E2E host: ${process.platform}/${process.arch}`)
  return target
}

async function resolveDesktopCodexBinary() {
  const configured = process.env.WEWORK_E2E_CODEX_BIN || process.env.CODEX_BIN
  if (configured) {
    return resolveExecutable(configured, 'codex', 'Configured Wework E2E Codex')
  }

  const target = hostCodexTarget()
  await runChecked('pnpm', ['run', 'prepare:codex', '--target', target], {
    cwd: weworkDir,
  })
  const lock = JSON.parse(await readFile(join(weworkDir, 'codex-binaries.lock.json'), 'utf8'))
  const binaryRelativePath = lock.targets?.[target]?.binaryPath
  assert.equal(typeof binaryRelativePath, 'string', `Codex lock is missing target ${target}`)
  return resolveExecutable(
    join(weworkDir, 'src-tauri', 'binaries', 'codex', target, binaryRelativePath),
    'codex',
    'Repository Codex'
  )
}

async function readTauriMainBinaryName() {
  const configPath = join(weworkDir, 'src-tauri', 'tauri.conf.json')
  try {
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    return config.mainBinaryName || 'app'
  } catch {
    return 'app'
  }
}

async function readTauriE2EWindowConfig() {
  const configPath = join(weworkDir, 'src-tauri', 'tauri.conf.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const windows = config.app?.windows
  assert.ok(Array.isArray(windows) && windows.length > 0, 'Tauri main window config is missing')
  return windows.map(windowConfig => ({
    ...windowConfig,
    backgroundThrottling: 'disabled',
  }))
}

function macCodexBundleLayout() {
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  return {
    binaryRelativePath: join('vendor', target, 'bin', 'codex'),
    target,
  }
}

function findCodexPackageRoot(codexBinary, binaryRelativePath) {
  const parts = binaryRelativePath.split('/')
  let packageRoot = codexBinary
  for (const _part of parts) packageRoot = dirname(packageRoot)
  return resolve(packageRoot, binaryRelativePath) === resolve(codexBinary) ? packageRoot : null
}

async function bundleMacCodex(contentsPath, codexBinary) {
  const { binaryRelativePath, target } = macCodexBundleLayout()
  const bundledPackageRoot = join(contentsPath, 'Resources', 'binaries', 'codex', target)
  const bundledCodexBinary = join(bundledPackageRoot, binaryRelativePath)
  const packageRoot = findCodexPackageRoot(codexBinary, binaryRelativePath)

  await mkdir(dirname(bundledPackageRoot), { recursive: true })
  if (packageRoot) {
    await symlink(packageRoot, bundledPackageRoot, 'dir')
  } else {
    await mkdir(dirname(bundledCodexBinary), { recursive: true })
    await copyFile(codexBinary, bundledCodexBinary)
    await chmod(bundledCodexBinary, 0o755)
  }

  assert.equal(
    await isExecutable(bundledCodexBinary),
    true,
    `The isolated macOS app did not contain an executable Codex at ${bundledCodexBinary}`
  )
  console.log(`Bundled E2E Codex: ${bundledCodexBinary}`)
  return bundledCodexBinary
}

async function wrapMacDesktopApp(binaryPath, binaryName, appIdentifier, codexBinary) {
  if (process.platform !== 'darwin') {
    return { binaryPath, appBundlePath: null, codexBinaryPath: null }
  }

  const appBundlePath = join(resultDir, `WeWork-E2E-${process.pid}.app`)
  const contentsPath = join(appBundlePath, 'Contents')
  const bundledBinaryPath = join(contentsPath, 'MacOS', binaryName)
  await mkdir(join(contentsPath, 'MacOS'), { recursive: true })
  await copyFile(binaryPath, bundledBinaryPath)
  await chmod(bundledBinaryPath, 0o755)
  await writeFile(
    join(contentsPath, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${binaryName}</string>
  <key>CFBundleIdentifier</key><string>${appIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>WeWork E2E ${process.pid}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
    `,
    'utf8'
  )
  const bundledCodexBinary = await bundleMacCodex(contentsPath, codexBinary)
  commandOutput(MACOS_LAUNCH_SERVICES_REGISTER, ['-f', appBundlePath])
  return {
    binaryPath: bundledBinaryPath,
    appBundlePath,
    codexBinaryPath: bundledCodexBinary,
  }
}

async function buildDesktopApp(
  controlUrl,
  cloudBackendUrl,
  cloudToken,
  appIdentifier,
  modelServerUrl,
  codexBinary
) {
  const configured = process.env.WEWORK_E2E_APP_BIN
  if (configured) {
    const binaryPath = await resolveExecutable(configured, 'app', 'Configured Wework desktop app')
    return wrapMacDesktopApp(binaryPath, binaryPath.split('/').at(-1), appIdentifier, codexBinary)
  }

  const windows = (await readTauriE2EWindowConfig()).map(window => ({
    ...window,
    backgroundThrottling: 'disabled',
    focus: false,
  }))
  await runChecked(
    'pnpm',
    [
      'exec',
      'tauri',
      'build',
      '--debug',
      '--no-bundle',
      '--config',
      JSON.stringify({
        identifier: appIdentifier,
        app: {
          windows,
          security: {
            capabilities: [
              'default',
              'workspace-window',
              {
                identifier: 'desktop-e2e-window',
                description: 'Allows the desktop E2E runner to manage test window visibility',
                windows: ['main'],
                permissions: ['core:window:allow-show', 'core:window:allow-unminimize'],
              },
            ],
          },
        },
      }),
    ],
    {
      cwd: weworkDir,
      env: {
        ...process.env,
        VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
        VITE_WEWORK_E2E_CLOUD_BACKEND_URL: cloudBackendUrl,
        VITE_WEWORK_E2E_CLOUD_TOKEN: cloudToken,
        VITE_WEWORK_E2E_MODEL_SERVER_URL: modelServerUrl,
        VITE_WEWORK_E2E_LOCAL_MODELS_CATALOG_READY:
          CLOUD_ONLY || CLOUD_FEATURES_ONLY ? 'true' : 'false',
        VITE_WEWORK_E2E: 'true',
        VITE_WEWORK_E2E_WORKTREE_CREATION_DELAY_MS: '1500',
        VITE_WEWORK_E2E_TRANSCRIPT_PAGE_SIZE: String(E2E_TRANSCRIPT_PAGE_SIZE),
        VITE_WEWORK_E2E_CODEX_HOME_INITIALIZATION: RUNS_PLUGIN_E2E ? 'true' : 'false',
        VITE_WEWORK_E2E_SEED_LOCAL_MODELS: RUNS_PLUGIN_E2E || MEMORY_ONLY ? 'false' : 'true',
        VITE_WEWORK_POSTHOG_HOST: modelServerUrl,
        VITE_WEWORK_POSTHOG_KEY: TELEMETRY_TEST_PROJECT_KEY,
        VITE_WEWORK_RELEASE_CHANNEL: 'stable',
        VITE_WEWORK_RUNTIME_MODE: 'local-first',
      },
    }
  )
  const mainBinaryName = await readTauriMainBinaryName()
  const binaryName = process.platform === 'win32' ? `${mainBinaryName}.exe` : mainBinaryName
  const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim()
  const candidates = [
    ...(cargoTargetDir ? [join(cargoTargetDir, 'debug', binaryName)] : []),
    join(weworkDir, 'src-tauri', 'target', 'debug', binaryName),
    join(
      weworkDir,
      'src-tauri',
      'target',
      'debug',
      'bundle',
      'macos',
      'WeWork.app',
      'Contents',
      'MacOS',
      binaryName
    ),
  ]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return wrapMacDesktopApp(candidate, binaryName, appIdentifier, codexBinary)
    }
  }
  throw new Error(
    `Tauri build did not produce an executable app. Checked: ${candidates.join(', ')}`
  )
}

async function verifyConnectedModelsOnLocalExecution({
  control,
  cloudEnvironment,
  setCodexUpstreamProtocol,
  workspacePath,
}) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-local-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await confirmLocalProjectName(control, 'workspace')
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const projectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project was not shown in the sidebar'
  )
  const projectMenuTestId = projectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(projectMenuTestId, 'The local matrix project did not expose its project menu')
  const projectId = projectMenuTestId.slice('project-menu-'.length)
  const newConversationSelector = `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`

  await verifyModelProtocolMatrix({
    cases: LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector,
    screenshotPrefix: 'local-connected-matrix',
    setCodexUpstreamProtocol,
    startIndex: LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES.length,
    workspacePath,
  })

  const currentProjectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project was not shown before removal'
  )
  const currentProjectMenuTestId = currentProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(currentProjectMenuTestId, 'The local matrix project did not expose its project menu')
  const currentProjectId = currentProjectMenuTestId.slice('project-menu-'.length)
  await control.command('click', `[data-testid="${currentProjectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${currentProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${currentProjectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project remained visible after removal'
  )
}

async function verifyCloudVisionFlows(control, composerSelector) {
  const projectRowSelector = '[data-testid^="project-row-"]'
  await verifyVisionSidecar({
    composerSelector,
    control,
    modelCase: CLOUD_VISION_SIDECAR_CASE,
    projectRowSelector,
  })
  await verifyMultimodalVision({
    composerSelector,
    control,
    modelCase: CLOUD_MULTIMODAL_VISION_CASE,
    projectRowSelector,
  })
}

async function verifyCloudProjectFlow(
  control,
  cloudEnvironment,
  restartDesktopApp,
  workspacePath,
  { visionOnly = false } = {}
) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const remoteDialogSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('standalone-remote-device-select') ||
      snapshot.testIds.includes('refresh-remote-devices-button'),
    'The remote device dialog exposed neither a connected device nor its refresh action'
  )
  if (!remoteDialogSnapshot.testIds.includes('standalone-remote-device-select')) {
    await control.command('clickIfPresent', '[data-testid="refresh-remote-devices-button"]')
  }
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The remote folder picker did not load the real executor home directory'
  )
  await captureVerificationScreenshot(control, 'cloud-01-remote-device-selected.png')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    workspacePath,
    'The remote folder picker did not retain the selected cloud workspace path'
  )
  await captureVerificationScreenshot(control, 'cloud-02-workspace-path-confirmed.png')
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('standalone-folder-project-dialog') &&
      value.testIds.some(testId => testId.startsWith('project-device-status-')),
    'The real cloud project was not shown with its remote device status'
  )
  await control.command('waitFor', '[data-testid^="project-menu-"]', {
    stableMs: COMPOSER_READY_STABILITY_MS * 2,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const projectSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const projectMenuTestIds = projectSnapshot.testIds.filter(testId =>
    testId.startsWith('project-menu-')
  )
  assert.equal(
    projectMenuTestIds.length,
    1,
    'The cloud flow did not expose exactly one remote project'
  )
  await captureVerificationScreenshot(control, 'cloud-03-project-created.png')
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="sidebar-cloud-connection-button"]', {
    text: '云端工作',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-work-01-plugin-entry.png')
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', '[data-testid="cloud-work-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', `[data-testid="connection-device-${CLOUD_DEVICE_ID}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const cloudWorkSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('cloud-work-project-')),
    'The cloud work page did not show the created cloud project'
  )
  const cloudWorkProjectTestId = cloudWorkSnapshot.testIds.find(testId =>
    testId.startsWith('cloud-work-project-')
  )
  assert.ok(cloudWorkProjectTestId, 'The cloud work page did not expose a project row')
  assert.equal(
    cloudWorkSnapshot.testIds.includes('general-settings-page'),
    false,
    'Clicking Cloud work from Plugins unexpectedly opened general settings'
  )
  await control.command('waitFor', `[data-testid="connection-device-metrics-${CLOUD_DEVICE_ID}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`)
  await control.command('waitFor', `[data-testid="connection-more-menu-${CLOUD_DEVICE_ID}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-work-02-device-and-project.png')
  await control.command('click', `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`)
  await control.command('click', `[data-testid="${cloudWorkProjectTestId}"]`)
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-work-03-project-opened.png')
  await control.command(
    'clickWhenEnabled',
    '[data-testid^="project-row-"] [data-testid="project-new-conversation-button"]'
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-04-conversation-ready.png')

  if (visionOnly) {
    await verifyCloudVisionFlows(control, composerSelector)
    return
  }

  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await openBottomWorkspaceTerminal(control, 'The new cloud task')
  await captureVerificationScreenshot(control, 'cloud-04b-new-task-terminal-open.png')
  await control.command('click', '[data-testid="close-bottom-workspace-tab-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The new cloud task terminal and bottom panel did not close cleanly',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.setScenario('cloud_initial')
  await sendPrompt(control, composerSelector, CLOUD_TASK_PROMPT)
  const cloudInitialRequest = await withTimeout(
    control.awaitScenarioRequestCount('cloud_initial', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The real cloud executor did not complete its model tool loop'
  )
  assert.equal(
    cloudInitialRequest.body?.model,
    DEFAULT_MODEL_ID,
    'The remote executor did not receive the selected canonical model id'
  )
  assert.equal(
    (await readFile(join(workspacePath, CLOUD_ARTIFACT_NAME), 'utf8')).trim(),
    CLOUD_ARTIFACT_CONTENT,
    'The real cloud executor did not create the verification artifact'
  )
  const taskRowTestId = await waitForTaskRowByText(control, 'WEWORK_DESKTOP_E2E_CLOUD_TASK')
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-05-initial-task-completed.png')

  await openBottomWorkspaceTerminal(control, 'The historical cloud task')
  await closeBottomWorkspacePanel(control)
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    'The historical cloud task did not restore its existing terminal',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('click', '[data-testid="workspace-terminal-new-tab-button"]')
  const addMenuSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.includes('workspace-terminal-new-tab-menu'),
    'The bottom workspace add menu did not open'
  )
  assert.ok(addMenuSnapshot.testIds.includes('workspace-add-terminal-option'))
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-ide-option'),
    false,
    'The bottom workspace add menu exposed IDE'
  )
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-desktop-option'),
    false,
    'The external build exposed the internal desktop extension'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await captureVerificationScreenshot(control, 'cloud-05b-historical-terminal-restored.png')
  await closeBottomWorkspacePanel(control)

  control.setScenario('cloud_follow_up')
  const runningTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-running-'
  )
  const unreadTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-unread-dot-'
  )
  await sendPrompt(control, composerSelector, CLOUD_FOLLOW_UP_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('cloud_follow_up'),
    DEFAULT_STEP_TIMEOUT_MS,
    'The real cloud executor did not send the follow-up model request'
  )
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes(runningTaskTestId) &&
      value.testIds.includes('pause-response-button') &&
      value.testIds.includes('thinking-indicator') &&
      !value.testIds.includes('send-message-button') &&
      !value.testIds.includes(unreadTaskTestId),
    'The cloud follow-up task did not render a consistent sidebar, composer, and message state',
    DEFAULT_STEP_TIMEOUT_MS
  )
  control.releaseCloudFollowUpResponse()
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    value => !value.testIds.includes(runningTaskTestId),
    'The cloud follow-up task did not settle before project removal'
  )
  await captureVerificationScreenshot(control, 'cloud-06-follow-up-completed.png')

  await verifyActiveGoalIdleUnreadLifecycle({
    composerSelector,
    control,
    executorLogPath: cloudEnvironment.remoteExecutorLogPath,
  })
  await verifyBusyTurnGoalHandoff({
    composerSelector,
    control,
    executorLogPath: cloudEnvironment.remoteExecutorLogPath,
  })

  await verifyCloudVisionFlows(control, composerSelector)

  await verifyAnthropicEmptyResponseRecovery({ composerSelector, control })

  await verifyModelProtocolMatrix({
    cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector:
      '[data-testid^="project-row-"] [data-testid="project-new-conversation-button"]',
    screenshotPrefix: 'cloud-matrix',
    setCodexUpstreamProtocol: protocol => cloudEnvironment.setCodexUpstreamProtocol(protocol),
    startIndex: LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.length,
    workspacePath,
  })

  const currentProjectSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.some(testId => testId.startsWith('project-menu-')),
    'The cloud project was not shown in the sidebar'
  )
  const currentProjectMenuTestId = currentProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(currentProjectMenuTestId, 'The cloud project did not expose its project menu')
  const currentProjectId = currentProjectMenuTestId.slice('project-menu-'.length)
  const projectMenuTestId = `project-menu-${currentProjectId}`
  await control.command('click', `[data-testid="${projectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${currentProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${currentProjectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes(projectMenuTestId) &&
      !value.testIds.includes(`remove-project-dialog-${currentProjectId}`),
    'The removed cloud project remained visible in the workbench'
  )
  await captureVerificationScreenshot(control, 'cloud-07-project-removed.png')

  const replacementWorkspacePath = join(dirname(workspacePath), 'replacement-workspace')
  await mkdir(replacementWorkspacePath, { recursive: true })
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The duplicate regression remote picker did not load the cloud executor home'
  )
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: replacementWorkspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, replacementWorkspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  const { projectId: replacementProjectId } = await waitForSingleProjectByTitle(
    control,
    'replacement-workspace',
    'Creating another cloud project restored the removed project instead of the replacement',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.notEqual(
    replacementProjectId,
    currentProjectId,
    'Creating another cloud project restored the removed project identity'
  )

  await cloudEnvironment.aliasCloudDeviceToCurrentApp()
  await createSingleRootLocalProject(control, replacementWorkspacePath, 'replacement-workspace')
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.filter(testId => testId.startsWith('project-menu-')).length === 1 &&
      snapshot.text.includes('replacement-workspace'),
    'Creating a local project while cloud work was connected exposed duplicate projects',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'cloud-08-local-project-deduplicated.png')

  await restartDesktopApp()
  const { projectId: restartedProjectId } = await waitForSingleProjectByTitle(
    control,
    'replacement-workspace',
    'Restarting Wework changed the deduplicated local and cloud project into multiple rows',
    RESTART_RECONCILE_TIMEOUT_MS
  )
  assert.notEqual(
    restartedProjectId,
    currentProjectId,
    'Restarting Wework restored the removed project identity'
  )
  await captureVerificationScreenshot(control, 'cloud-09-local-project-deduplicated-restart.png')
}

async function verifyRetryFailureRestoration(control, composerSelector) {
  control.setScenario('retry')
  await sendPromptUntilScenarioRequest(control, composerSelector, RETRY_PROMPT, 'retry')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const retryDebugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const retryTaskId = retryDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(retryTaskId, 'The failed retry task did not expose its runtime task ID')
  const retryTaskRowTestId = `runtime-local-task-row-${retryTaskId}`
  await control.command('waitFor', `[data-testid="${retryTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${retryTaskRowTestId}"]`)
  await waitForWorkbenchTask(
    control,
    retryTaskId,
    'The failed retry task did not become active again'
  )
  await control.command(
    'clickIfPresent',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-details-toggle"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      text: RETRY_CODEX_ERROR_TEXT,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await captureVerificationScreenshot(
    control,
    'retry-01-failure-restored-after-switch.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-retry"]`
  )
  await waitForScenarioRequestCount(control, 'retry', 2)
  control.releaseRetryResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: RETRY_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  let successfulRetrySnapshot = JSON.parse(
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
  )
  assert.equal(
    successfulRetrySnapshot.testIds.includes('assistant-error-card'),
    false,
    'The failed attempt card remained after retry succeeded'
  )
  assert.equal(
    successfulRetrySnapshot.testIds.filter(testId => testId === 'message-assistant').length,
    1,
    'Retry success left an empty assistant turn in the live conversation'
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${retryTaskRowTestId}"]`)
  await waitForWorkbenchTask(
    control,
    retryTaskId,
    'The successful retry task did not become active again'
  )
  await control.command(
    'clickIfPresent',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: RETRY_COMPLETION_TEXT,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  successfulRetrySnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    successfulRetrySnapshot.testIds.includes('assistant-error-card'),
    false,
    'A cached failure card returned after reopening the successfully retried conversation'
  )
  assert.equal(
    successfulRetrySnapshot.testIds.filter(testId => testId === 'message-assistant').length,
    1,
    'Reopening a successful retry restored an empty failed assistant turn'
  )
  await captureVerificationScreenshot(
    control,
    'retry-02-success-restored-without-failed-turn.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    control.scenarioRequests.get('retry')?.length,
    2,
    'Retry did not issue exactly one additional request for the failed user message'
  )
}

async function verifyModelProtocolMatrix({
  cases,
  composerSelector,
  control,
  newConversationSelector,
  screenshotPrefix,
  setCodexUpstreamProtocol,
  startIndex = 0,
  workspacePath,
}) {
  let hasConfirmedCatalogSync = false
  for (const [caseIndex, model] of cases.entries()) {
    const matrixIndex = startIndex + caseIndex
    console.log(
      `Model protocol matrix ${matrixIndex + 1}/${MODEL_PROTOCOL_MATRIX_TOTAL} started: ${matrixCaseId(model)}`
    )
    if (model.source === 'codex') {
      assert.ok(
        setCodexUpstreamProtocol,
        `${matrixCaseId(model)} requires a Codex upstream protocol setter`
      )
      await setCodexUpstreamProtocol(model.protocol)
    }
    control.setMatrixCase(model)
    await control.command('clickWhenEnabled', newConversationSelector)
    await control.command('waitFor', composerSelector, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, model.optionIds, model.labels)

    const confirmCloudModelCatalogSync =
      !hasConfirmedCatalogSync && model.execution === 'cloud' && model.source === 'local'
    await sendPromptWithButton(
      control,
      composerSelector,
      matrixTextPrompt(model),
      MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
      {
        confirmCloudModelCatalogSync,
      }
    )
    if (confirmCloudModelCatalogSync) {
      hasConfirmedCatalogSync = true
    }
    await waitForMatrixStage(control, model, 'tool')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: matrixTextCompletion(model),
      timeoutMs: MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
    })

    await sendPromptWithButton(control, composerSelector, matrixToolPrompt(model))
    await waitForMatrixStage(control, model, 'awaiting_tool_output', 'complete')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: matrixToolCompletion(model),
      timeoutMs: MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
    })
    assert.equal(
      (await readFile(join(workspacePath, matrixArtifact(model)), 'utf8')).trim(),
      matrixArtifactContent(model),
      `${matrixCaseId(model)} apply_patch did not create the expected artifact`
    )
    assert.equal(
      control.matrixState?.stage,
      'complete',
      `${matrixCaseId(model)} did not complete text and tool turns`
    )
    assert.ok(
      control.matrixState.requests.length >= 3,
      `${matrixCaseId(model)} did not send the text/tool/tool-output request sequence`
    )
    await prepareCompletedTurnScreenshot(control)
    await captureVerificationScreenshot(
      control,
      `${screenshotPrefix}-${String(matrixIndex + 1).padStart(2, '0')}-${matrixCaseId(model)}.png`
    )
    console.log(`Model protocol matrix passed: ${matrixCaseId(model)}`)
  }
}

async function waitForMatrixStage(control, model, ...expectedStages) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < MODEL_PROTOCOL_MATRIX_TIMEOUT_MS) {
    if (control.fatalError) throw control.fatalError
    if (expectedStages.includes(control.matrixState?.stage)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(
    `${matrixCaseId(model)} did not reach ${expectedStages.join(' or ')} within ${MODEL_PROTOCOL_MATRIX_TIMEOUT_MS}ms; current stage=${control.matrixState?.stage ?? 'missing'}`
  )
}

export {
  writeCodexConfig,
  toolDetailsMcpConfigToml,
  codexUpstreamApiFormat,
  buildExecutor,
  hostCodexTarget,
  resolveDesktopCodexBinary,
  readTauriMainBinaryName,
  readTauriE2EWindowConfig,
  macCodexBundleLayout,
  findCodexPackageRoot,
  bundleMacCodex,
  wrapMacDesktopApp,
  buildDesktopApp,
  verifyConnectedModelsOnLocalExecution,
  verifyCloudProjectFlow,
  verifyRetryFailureRestoration,
  verifyModelProtocolMatrix,
  waitForMatrixStage,
}
