import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

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
  REMOTE_DOCKER_DEVICE_ID,
  CLOUD_MULTIMODAL_VISION_CASE,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_TASK_PROMPT,
  CLOUD_VISION_SIDECAR_CASE,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  MACOS_LAUNCH_SERVICES_REGISTER,
  MEMORY_ONLY,
  MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  MODEL_PROTOCOL_MATRIX_TOTAL,
  MODEL_PROVIDER_ID,
  RETRY_CODEX_ERROR_TEXT,
  RETRY_COMPLETION_TEXT,
  RETRY_PROMPT,
  RUNS_PLUGIN_E2E,
  SELECTED_DESKTOP_SEGMENT,
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
  mcpElicitationServerPath,
  randomUUID,
  readFile,
  rename,
  repoDir,
  resolve,
  resolveExecutable,
  resultDir,
  rm,
  runChecked,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  toolDetailsMcpServerPath,
  weworkDir,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { waitForTaskRowByText } from './task-state-flows.mjs'
import { remoteDeviceE2EExtension } from '../remote-device-extension.mjs'

import {
  captureVerificationScreenshot,
  waitForControlValue,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForWorkbenchTask,
} from './workspace-flows.mjs'

const REMOTE_TERMINAL_SIZE_MARKER = 'WEWORK_DESKTOP_E2E_REMOTE_TERMINAL_SIZE'
const REMOTE_TERMINAL_SELECTOR = '[data-testid="remote-terminal"]'

async function verifyRemoteTerminalUsesPanelWidth(control) {
  await control.command('waitFor', `${REMOTE_TERMINAL_SELECTOR} .xterm-screen`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let lastReportedSize = 'none'
  let terminalText = ''
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    await control.command('terminalInput', REMOTE_TERMINAL_SELECTOR, {
      value: `stty size | sed 's/^/${REMOTE_TERMINAL_SIZE_MARKER}=/'\r`,
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
    terminalText = await control.command('getTerminalText', REMOTE_TERMINAL_SELECTOR)
    const sizes = Array.from(
      terminalText.matchAll(/WEWORK_DESKTOP_E2E_REMOTE_TERMINAL_SIZE=(\d+)\s+(\d+)/gu)
    )
    const size = sizes.at(-1)
    if (size) {
      lastReportedSize = size[0]
      if (Number(size[2]) > 80) return
    }
  }
  throw new Error(
    `The remote PTY did not reach the fitted panel width; last size: ${lastReportedSize}; terminal: ${terminalText.slice(-2000)}`
  )
}

async function waitForSingleProjectByTitle(control, expectedTitle, message, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const projectMenuTestIds = snapshot.testIds.filter(testId => testId.startsWith('project-menu-'))
    const matchingProjectIds = []
    for (const projectMenuTestId of projectMenuTestIds) {
      const projectId = projectMenuTestId.slice('project-menu-'.length)
      const title = await control.command('getText', `[data-testid="project-title-${projectId}"]`)
      if (title.trim() === expectedTitle) matchingProjectIds.push(projectId)
    }
    if (matchingProjectIds.length === 1) {
      return { projectId: matchingProjectIds[0], snapshot }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForWorkbenchDeviceStatus(control, deviceId, expectedStatus, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const device = snapshot.workbench?.devices?.find(item => item.device_id === deviceId)
    if (device?.status === expectedStatus) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForProjectTitleToRemainAbsent(control, projectTitle, message) {
  const startedAt = Date.now()
  let absentSince = null
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const projectIds = snapshot.testIds
      .filter(testId => testId.startsWith('project-menu-'))
      .map(testId => testId.slice('project-menu-'.length))
    const titles = await Promise.all(
      projectIds.map(projectId =>
        control.command('getText', `[data-testid="project-title-${projectId}"]`)
      )
    )
    if (titles.some(title => title.trim() === projectTitle)) {
      absentSince = null
    } else {
      absentSince ??= Date.now()
      if (Date.now() - absentSince >= COMPOSER_READY_STABILITY_MS * 4) return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function verifyOfflineRemoteProjectRemoval({
  control,
  cloudEnvironment,
  preservedProjectTitle,
  restartDesktopApp,
}) {
  const projectTitle = 'offline-removal-workspace'
  const workspacePath = join(resultDir, 'remote-docker-executor-home', 'offline-removal-workspace')
  await mkdir(workspacePath, { recursive: true })
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: REMOTE_DOCKER_DEVICE_ID,
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-source-existing"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'remote-docker-executor-home'),
    'The offline-removal picker did not load the remote Docker executor home'
  )
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForSingleProjectByTitle(
    control,
    projectTitle,
    'The real remote Docker project was not created for offline removal',
    WORKBENCH_READY_TIMEOUT_MS
  )

  await cloudEnvironment.stopRemoteDockerExecutorAndWaitOffline()
  await waitForWorkbenchDeviceStatus(
    control,
    REMOTE_DOCKER_DEVICE_ID,
    'offline',
    'Wework did not render the remote Docker device as offline'
  )
  await captureVerificationScreenshot(control, 'cloud-03a-offline-project-visible.png')
  const { projectId: offlineProjectId } = await waitForSingleProjectByTitle(
    control,
    projectTitle,
    'The offline remote Docker project changed identity without remaining visible',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await control.command('click', `[data-testid="project-menu-${offlineProjectId}"]`)
  await control.command('click', `[data-testid="remove-project-${offlineProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${offlineProjectId}-confirm-button"]`
  )
  await waitForProjectTitleToRemainAbsent(
    control,
    projectTitle,
    'The offline remote project remained visible after local removal'
  )
  await captureVerificationScreenshot(control, 'cloud-03b-offline-project-removed.png')

  await restartDesktopApp()
  await waitForSingleProjectByTitle(
    control,
    preservedProjectTitle,
    'The restarted Wework app did not restore the existing cloud project',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await waitForWorkbenchDeviceStatus(
    control,
    REMOTE_DOCKER_DEVICE_ID,
    'offline',
    'The restarted Wework app did not restore the offline device state'
  )
  await waitForProjectTitleToRemainAbsent(
    control,
    projectTitle,
    'Restarting Wework restored the locally removed offline project'
  )
  await captureVerificationScreenshot(control, 'cloud-03c-offline-project-absent-restart.png')
  await control.command('dispatchLocalModelSettingsChanged', '')
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

function mcpElicitationConfigToml(evidencePath) {
  const command = JSON.stringify(process.execPath)
  const server = JSON.stringify(mcpElicitationServerPath)
  const evidence = JSON.stringify(evidencePath)
  return [
    '[mcp_servers.wegent_sites_interactions]',
    `command = ${command}`,
    `args = [${server}, ${evidence}]`,
    'default_tools_approval_mode = "prompt"',
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
  const configured = process.env.WEWORK_E2E_CODEX_BIN
  if (configured) {
    return resolveExecutable(configured, 'codex', 'Configured Wework E2E Codex')
  }

  const target = hostCodexTarget()
  await runChecked('pnpm', ['run', 'prepare:codex', '--target', target], {
    cwd: weworkDir,
  })
  const lock = JSON.parse(await readFile(join(weworkDir, 'codex-binaries.lock.json'), 'utf8'))
  const entry = lock.targets?.[target]
  const binaryRelativePath = entry?.binaryPath
  assert.equal(typeof binaryRelativePath, 'string', `Codex lock is missing target ${target}`)
  assert.equal(typeof entry.version, 'string', `Codex lock is missing the version for ${target}`)
  assert.equal(typeof entry.integrity, 'string', `Codex lock is missing integrity for ${target}`)
  const integrityKey = createHash('sha256').update(entry.integrity).digest('hex').slice(0, 16)
  const tarballName = `codex-${entry.version}-${target}-${integrityKey}`
  return resolveExecutable(
    join(codexCacheRoot(), 'extracted', tarballName, binaryRelativePath),
    'codex',
    'Repository Codex'
  )
}

function codexCacheRoot() {
  if (process.env.WEGENT_CODEX_CACHE_DIR?.trim()) {
    return resolve(process.env.WEGENT_CODEX_CACHE_DIR.trim())
  }
  if (process.platform === 'darwin') {
    return join(process.env.HOME || tmpdir(), 'Library', 'Caches', 'wegent', 'codex')
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || process.env.USERPROFILE || tmpdir(), 'wegent', 'codex')
  }
  return join(
    process.env.XDG_CACHE_HOME || join(process.env.HOME || tmpdir(), '.cache'),
    'wegent',
    'codex'
  )
}

async function prepareHarnessRuntimeRoots(appBinary) {
  const packagedResourcesRoot = join(
    dirname(appBinary),
    ...(process.platform === 'darwin' ? ['..', 'Resources'] : ['resources'])
  )
  const packagedResources = join(packagedResourcesRoot, 'harness-runtime')
  const catalogPath = join(packagedResources, 'runtimes.json')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  const runtimeRoot = join(resultDir, 'harness-runtime')
  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(runtimeRoot, { recursive: true })
  for (const runtime of catalog.runtimes) {
    const archivePath = join(packagedResources, runtime.assetName)
    const extracted = join(runtimeRoot, runtime.sourceFingerprint)
    await mkdir(extracted, { recursive: true })
    await runChecked('tar', ['-xzf', archivePath, '-C', extracted], { cwd: weworkDir })
    const dshEntry = join(extracted, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await readFile(dshEntry)
  }

  return {
    corePluginsRoot: join(packagedResourcesRoot, 'wework-core-plugins'),
    harnessRuntimeRoot: runtimeRoot,
  }
}

async function cloneMacElectronApp(binaryPath, appIdentifier, codexBinary) {
  if (process.platform !== 'darwin') {
    return { binaryPath, appBundlePath: null, codexBinaryPath: codexBinary }
  }

  const sourceBundlePath = resolve(binaryPath, '..', '..', '..')
  const appBundlePath = join(resultDir, `WeWork-Electron-E2E-${process.pid}.app`)
  const binaryName = binaryPath.split('/').at(-1)
  assert.ok(binaryName, `Unable to determine the Electron executable name from ${binaryPath}`)
  await rm(appBundlePath, { recursive: true, force: true })
  await runChecked('/bin/cp', ['-cR', sourceBundlePath, appBundlePath])
  if (process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE !== '1') {
    await runChecked('/usr/libexec/PlistBuddy', [
      '-c',
      `Set :CFBundleIdentifier ${appIdentifier}`,
      join(appBundlePath, 'Contents', 'Info.plist'),
    ])
    await runChecked('codesign', ['--force', '--deep', '--sign', '-', appBundlePath])
  }
  commandOutput(MACOS_LAUNCH_SERVICES_REGISTER, ['-f', appBundlePath])
  return {
    binaryPath: join(appBundlePath, 'Contents', 'MacOS', binaryName),
    appBundlePath,
    codexBinaryPath: codexBinary,
  }
}

async function buildDesktopApp(appIdentifier, codexBinary) {
  const configured = process.env.WEWORK_E2E_APP_BIN
  assert.ok(
    configured,
    'Electron desktop E2E requires WEWORK_E2E_APP_BIN from pnpm ai:verify:electron:build'
  )
  const binaryPath = await resolveExecutable(configured, 'app', 'Configured Wework Electron app')
  return cloneMacElectronApp(binaryPath, appIdentifier, codexBinary)
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

export async function verifyRemoteDockerCommandFlow(control, cloudEnvironment) {
  await control.command('navigate', 'body', { value: '/settings/connections?addDevice=1' })
  await control.command('waitFor', '[data-testid="add-cloud-device-dialog"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const setupSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="add-cloud-device-dialog"]')
  )
  assert.equal(
    setupSnapshot.testIds.includes('remote-docker-public-url-input'),
    false,
    'The remote Docker setup still exposed a manual IDE URL input'
  )
  await control.command('clickWhenEnabled', '[data-testid="add-remote-docker-button"]')
  await control.command('waitFor', '[data-testid="remote-docker-command"]', {
    text: remoteDeviceE2EExtension.commandMarker,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const commandSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="remote-docker-command"]')
  )
  remoteDeviceE2EExtension.assertCommand({
    assert,
    command: commandSnapshot.text,
    backendUrl: cloudEnvironment.backendUrl,
    socketUrl: cloudEnvironment.socketUrl,
  })
  let runnableCommandSnapshot = commandSnapshot
  if (remoteDeviceE2EExtension.supportsStatusRecovery) {
    await control.command('waitFor', '[data-testid="remote-docker-connection-status"]', {
      text: '连接失败',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('clickWhenEnabled', '[data-testid="add-remote-docker-button"]')
    runnableCommandSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.text.includes(remoteDeviceE2EExtension.commandMarker) &&
        snapshot.text !== commandSnapshot.text,
      'Regenerating the remote Docker command did not replace the failed command',
      WORKBENCH_READY_TIMEOUT_MS,
      '[data-testid="remote-docker-command"]'
    )
  }
  await control.command('click', '[data-testid="copy-remote-docker-command"]')
  await control.command('waitFor', '[data-testid="copy-remote-docker-command"]', {
    text: '已复制',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getClipboardText', ''),
    runnableCommandSnapshot.text,
    'The remote Docker command was not copied into the desktop E2E clipboard'
  )
  await captureVerificationScreenshot(control, 'cloud-00-remote-docker-command.png')
  const generatedDeviceId = runnableCommandSnapshot.text.match(/DEVICE_ID=([^\s\\]+)/)?.[1]
  const generatedDeviceName = runnableCommandSnapshot.text.match(/DEVICE_NAME=([^\s\\]+)/)?.[1]
  const generatedAuthToken = runnableCommandSnapshot.text.match(/WEGENT_AUTH_TOKEN=([^\s\\]+)/)?.[1]
  assert.ok(generatedDeviceId, 'The generated command did not include a device ID')
  assert.ok(generatedDeviceName, 'The generated command did not include a device name')
  assert.ok(generatedAuthToken, 'The generated command did not include an auth token')
  await cloudEnvironment.startGeneratedRemoteDevice({
    deviceId: generatedDeviceId,
    deviceName: generatedDeviceName,
    authToken: generatedAuthToken,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('add-cloud-device-dialog') &&
      snapshot.testIds.includes(`connection-device-${generatedDeviceId}`),
    'The generated remote device did not close the dialog and refresh the device list'
  )
  await control.command('navigate', 'body', { value: '/' })
}

export async function verifyLocalRemoteControlFlow(control, cloudEnvironment) {
  await control.command('setAppPreferences', 'body', {
    value: JSON.stringify({ remoteControlEnabled: false }),
  })
  await control.command('navigate', 'body', { value: '/settings/connections' })
  await control.command('waitFor', '[data-testid="remote-control-toggle"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', '[data-testid="remote-control-toggle"]', {
      value: 'aria-checked',
    }),
    'false',
    'Remote control should default to disabled'
  )

  const initialDevice = await cloudEnvironment.waitForConnectedAppDevice()
  assert.ok(initialDevice.runtime_instance_id, 'The app device did not expose a Runtime identity')
  assert.ok(initialDevice.app_device_id, 'The app device did not expose its physical app identity')

  await control.command('click', '[data-testid="remote-control-toggle"]')
  const remoteDevice = await cloudEnvironment.waitForDeviceType(initialDevice.device_id, 'remote')
  assert.equal(remoteDevice.device_id, initialDevice.device_id)
  assert.equal(remoteDevice.runtime_instance_id, initialDevice.runtime_instance_id)
  assert.equal(remoteDevice.app_device_id, initialDevice.app_device_id)
  assert.equal(
    await control.command('getAttribute', '[data-testid="remote-control-toggle"]', {
      value: 'aria-checked',
    }),
    'true',
    'Remote control switch did not stay enabled'
  )
  const runtimeSettings = await cloudEnvironment.runtimeSettings(initialDevice.device_id)
  assert.equal(runtimeSettings.device_id, initialDevice.device_id)
  await captureVerificationScreenshot(control, 'cloud-00-local-remote-control-enabled.png')

  await control.command('click', '[data-testid="remote-control-toggle"]')
  const appDevice = await cloudEnvironment.waitForDeviceType(initialDevice.device_id, 'app')
  assert.equal(appDevice.device_id, initialDevice.device_id)
  assert.equal(appDevice.runtime_instance_id, initialDevice.runtime_instance_id)
  assert.equal(appDevice.app_device_id, initialDevice.app_device_id)
  assert.equal(
    (await cloudEnvironment.devices()).filter(
      device => device.device_id === initialDevice.device_id
    ).length,
    1,
    'Toggling remote control created a duplicate device registration'
  )
  assert.equal(
    await control.command('getAttribute', '[data-testid="remote-control-toggle"]', {
      value: 'aria-checked',
    }),
    'false',
    'Remote control switch did not stay disabled'
  )
  await assert.rejects(
    () => cloudEnvironment.runtimeSettings(initialDevice.device_id),
    /Remote control is disabled for this app device/
  )
  await control.command('navigate', 'body', { value: '/' })
}

async function verifyFailedCloudConnectionCanDisconnect(control) {
  await control.command('waitFor', '[data-testid="sidebar-cloud-connection-button"]', {
    text: '云端工作',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('hover', '[data-testid="sidebar-cloud-connection-button"]')
  await control.command('click', '[data-testid="sidebar-cloud-management-button"]')
  await control.command('waitFor', '[data-testid="settings-cloud-disconnect-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="settings-cloud-disconnect-button"]')
  await control.command('waitFor', '[data-testid="settings-cloud-connect-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="settings-cloud-connect-button"]')
  await control.command('fill', '[data-testid="cloud-backend-url-input"]', {
    value: 'http://127.0.0.1:1',
  })
  await control.command('click', '[data-testid="cloud-authorization-submit-button"]')
  await control.command('waitFor', '[data-testid="cloud-connection-error"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="cloud-disconnect-button"]', {
    text: '断开连接',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="cloud-disconnect-button"]')
  await control.command('waitFor', '[data-testid="settings-cloud-connect-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('cloud-connection-dialog'),
    'Disconnecting a failed cloud connection did not clear the sidebar error state'
  )
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
  await verifyLocalRemoteControlFlow(control, cloudEnvironment)
  await verifyRemoteDockerCommandFlow(control, cloudEnvironment)
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
  await control.command(
    'waitFor',
    `[data-testid="standalone-remote-device-option-${REMOTE_DOCKER_DEVICE_ID}"]`,
    { text: 'Remote Docker', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: REMOTE_DOCKER_DEVICE_ID,
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-source-existing"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'remote-docker-executor-home'),
    'The remote Docker device was not selectable from the real desktop device picker'
  )
  await captureVerificationScreenshot(control, 'cloud-01-remote-docker-device-selected.png')
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The remote folder picker did not load the real executor home directory'
  )
  await captureVerificationScreenshot(control, 'cloud-02-cloud-device-selected.png')
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
  await captureVerificationScreenshot(control, 'cloud-03-workspace-path-confirmed.png')
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
  const preservedProjectId = projectMenuTestIds[0].slice('project-menu-'.length)
  const preservedProjectTitle = (
    await control.command('getText', `[data-testid="project-title-${preservedProjectId}"]`)
  ).trim()
  await captureVerificationScreenshot(control, 'cloud-03-project-created.png')
  await verifyOfflineRemoteProjectRemoval({
    control,
    cloudEnvironment,
    preservedProjectTitle,
    restartDesktopApp,
  })
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
  await verifyRemoteTerminalUsesPanelWidth(control)
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
  const runningTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-running-'
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes(runningTaskTestId) &&
      value.testIds.includes('pause-response-button') &&
      !value.testIds.includes('send-message-button'),
    'The initial cloud task did not remain active while streaming text',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  control.releaseCloudInitialResponse()
  await waitForSnapshot(
    control,
    value => !value.testIds.includes(runningTaskTestId),
    'The initial cloud task did not settle after its streamed response completed',
    DEFAULT_STEP_TIMEOUT_MS
  )
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
      !value.testIds.includes('send-message-button') &&
      !value.testIds.includes(unreadTaskTestId),
    'The cloud follow-up task did not remain active while streaming text',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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
  await control.command('clickWhenEnabled', '[data-testid="remote-project-source-existing"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
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
  await waitForSingleProjectByTitle(
    control,
    'replacement-workspace',
    'Creating a local project while cloud work was connected exposed duplicate projects',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'cloud-08-local-project-deduplicated.png')

  await restartDesktopApp()
  const { projectId: restartedProjectId } = await waitForSingleProjectByTitle(
    control,
    'replacement-workspace',
    'Restarting Wework changed the deduplicated local and cloud project into multiple rows',
    WORKBENCH_READY_TIMEOUT_MS
  )
  assert.notEqual(
    restartedProjectId,
    currentProjectId,
    'Restarting Wework restored the removed project identity'
  )
  await captureVerificationScreenshot(control, 'cloud-09-local-project-deduplicated-restart.png')
  await verifyFailedCloudConnectionCanDisconnect(control)
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
  const retryFailureDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const assistantCountBeforeRetry = Number(
    retryFailureDebugSnapshot.pane?.messageSummary?.byRole?.assistant ?? 0
  )
  const userCountBeforeRetry = Number(
    retryFailureDebugSnapshot.pane?.messageSummary?.byRole?.user ?? 0
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
    true,
    'Retry removed the failed attempt instead of preserving the conversation history'
  )
  const successfulRetryDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const successfulRetryAssistantCount = Number(
    successfulRetryDebugSnapshot.pane?.messageSummary?.byRole?.assistant ?? 0
  )
  assert.equal(
    successfulRetryAssistantCount,
    assistantCountBeforeRetry + 1,
    'Retry did not append the successful assistant response as a new turn'
  )
  const successfulRetryUserCount = Number(
    successfulRetryDebugSnapshot.pane?.messageSummary?.byRole?.user ?? 0
  )
  assert.equal(
    successfulRetryUserCount,
    userCountBeforeRetry + 1,
    'Retry did not append a continuation user message'
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
    true,
    'Reopening the conversation lost the preserved failed attempt'
  )
  const reopenedRetryDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    Number(reopenedRetryDebugSnapshot.pane?.messageSummary?.byRole?.assistant ?? 0),
    successfulRetryAssistantCount,
    'Reopening the conversation lost the successful continuation turn'
  )
  assert.equal(
    Number(reopenedRetryDebugSnapshot.pane?.messageSummary?.byRole?.user ?? 0),
    successfulRetryUserCount,
    'Reopening the conversation lost the continuation user message'
  )
  await captureVerificationScreenshot(
    control,
    'retry-02-success-restored-with-failed-turn.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    control.scenarioRequests.get('retry')?.length,
    2,
    'Retry did not issue exactly one continuation request'
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
  mcpElicitationConfigToml,
  codexUpstreamApiFormat,
  buildExecutor,
  hostCodexTarget,
  resolveDesktopCodexBinary,
  prepareHarnessRuntimeRoots,
  buildDesktopApp,
  verifyConnectedModelsOnLocalExecution,
  verifyCloudProjectFlow,
  verifyRetryFailureRestoration,
  verifyModelProtocolMatrix,
  waitForMatrixStage,
}
