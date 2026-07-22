import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, appendFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDesktopScenario } from './scenario-loader.mjs'
import { stopProcess, stopProcessGroup } from './process-lifecycle.mjs'

const DESKTOP_READY_TIMEOUT_MS = 60_000
const WORKBENCH_READY_TIMEOUT_MS = 180_000
const UI_TIMEOUT_MS = 120_000
const COMPOSER_READY_STABILITY_MS = 750
const TASK_PROMPT = 'WEWORK_DESKTOP_E2E_TASK: create the requested verification file.'
const COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_COMPLETE'
const FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_FOLLOW_UP: confirm the completed task.'
const FOLLOW_UP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FOLLOW_UP_COMPLETE'
const REQUEST_USER_INPUT_PROMPT =
  'WEWORK_DESKTOP_E2E_REQUEST_INPUT: ask which implementation direction to use.'
const REQUEST_USER_INPUT_QUESTION = 'Which implementation direction should be used?'
const REQUEST_USER_INPUT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_REQUEST_INPUT_COMPLETE'
const SEND_MODE_DRAFT = 'WEWORK_DESKTOP_E2E_SEND_MODE_DRAFT'
const WINDOW_LIFECYCLE_PROMPT =
  'WEWORK_DESKTOP_E2E_WINDOW_LIFECYCLE: keep this response running until released.'
const WINDOW_LIFECYCLE_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_WINDOW_LIFECYCLE_COMPLETE'
const CANCELLATION_PROMPT = 'WEWORK_DESKTOP_E2E_CANCEL: wait until the response is cancelled.'
const CANCELLATION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CANCEL_COMPLETE'
const RETRY_PROMPT = 'WEWORK_DESKTOP_E2E_RETRY: fail once and then succeed after retry.'
const RETRY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RETRY_COMPLETE'
const RECONNECT_PROMPT = 'WEWORK_DESKTOP_E2E_RECONNECT: recover after the stream disconnects.'
const RECONNECT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RECONNECT_COMPLETE'
const MEMORY_PROMPT = 'WEWORK_DESKTOP_E2E_MEMORY: run a tool and stream the report.'
const MEMORY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_MEMORY_COMPLETE'
const MEMORY_SAMPLE_INTERVAL_MS = 500
const MEMORY_MAX_PEAK_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB ?? 512 * 1024
)
const MEMORY_MAX_SETTLED_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB ?? 256 * 1024
)
const ARTIFACT_NAME = 'wework-e2e-result.txt'
const ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_TOOL'
const IMAGE_ARTIFACT_NAME = 'wework-e2e-image.png'
const IMAGE_ARTIFACT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'
const GIT_SEED_NAME = 'README.md'
const GIT_SEED_CONTENT = '# Desktop E2E workspace\n'
const MODEL_API_KEY = 'wework-e2e-test-key'
const MODEL_PROVIDER_ID = 'wework-e2e'
const MODEL_ID = 'gpt-5.4'
const MODEL_LABEL = 'GPT 5.4'
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Put only the tool input in this field, preserve every character exactly, and follow the original definition embedded in the function description. Do not add Markdown fences or explanatory text.'
const DEFAULT_MODEL_ID = 'gpt-5.4-mini'
const DEFAULT_MODEL_LABEL = 'GPT 5.4 Mini'
const LOCAL_MODEL_CASES = [
  {
    protocol: 'responses',
    optionId: 'local-model:desktop-e2e-responses',
    label: 'Desktop E2E Responses',
    modelId: 'desktop-e2e-responses-model',
  },
  {
    protocol: 'chat',
    optionId: 'local-model:desktop-e2e-chat',
    label: 'Desktop E2E Chat',
    modelId: 'desktop-e2e-chat-model',
  },
  {
    protocol: 'anthropic',
    optionId: 'local-model:desktop-e2e-anthropic',
    label: 'Desktop E2E Anthropic',
    modelId: 'desktop-e2e-anthropic-model',
  },
]
const BLOCKED_CLOUD_MODEL_PATH = '/api/models/unified'
const CLOUD_DEVICE_ID = 'wework-e2e-cloud-device'
const FRESH_CHAT_PROMPT = 'WEWORK_DESKTOP_E2E_FRESH_CHAT: confirm this is a new conversation.'
const FRESH_CHAT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FRESH_CHAT_COMPLETE'
const COMPOSER_PROJECT_NAME = 'Composer Flow Project'
const ATTACHMENT_ONLY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_ATTACHMENT_ONLY_COMPLETE'
const ATTACHMENT_ONLY_FILENAME = 'same-name-attachment.png'
const SIDE_CHAT_PROMPT = 'WEWORK_DESKTOP_E2E_SIDE_CHAT: verify isolated attachments.'
const SIDE_CHAT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_COMPLETE'
const SIDE_CHAT_FILENAME = 'side-chat-only.png'
const CLOUD_TASK_PROMPT =
  'WEWORK_DESKTOP_E2E_CLOUD_TASK: create the requested cloud verification file.'
const CLOUD_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CLOUD_COMPLETE'
const CLOUD_FOLLOW_UP_PROMPT =
  'WEWORK_DESKTOP_E2E_CLOUD_FOLLOW_UP: confirm the cloud task remains available.'
const CLOUD_FOLLOW_UP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CLOUD_FOLLOW_UP_COMPLETE'
const CLOUD_ARTIFACT_NAME = 'wework-cloud-e2e-result.txt'
const CLOUD_ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_CLOUD_TOOL'
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ACTIVE_SEND_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
const MACOS_LAUNCH_SERVICES_REGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const LIFECYCLE_ONLY = process.argv.includes('--lifecycle-only')
const REQUEST_INPUT_ONLY = process.env.WEWORK_DESKTOP_E2E_REQUEST_INPUT_ONLY === '1'
const RECONNECT_ONLY = process.argv.includes('--reconnect-only')
const VIEW_IMAGE_ONLY = process.argv.includes('--view-image-only')
const ATTACHMENT_ONLY_SIDEBAR = process.argv.includes('--attachment-only-sidebar')
const SIDE_CHAT_ATTACHMENT_ONLY = process.argv.includes('--side-chat-attachment-only')
const CLOUD_ONLY = process.argv.includes('--cloud-only')
const PLUGINS_ONLY = process.argv.includes('--plugins-only')
const MEMORY_ONLY = process.argv.includes('--memory-only')
const DESKTOP_SCENARIO_ONLY = process.env.WEWORK_E2E_DESKTOP_SCENARIO_ONLY === 'true'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..', '..')
const repoDir = resolve(weworkDir, '..')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const resultDir = join(weworkDir, 'test-results', 'desktop-e2e', runId)

const PLUGIN_MARKETPLACE_NAME = 'desktop-e2e-marketplace'
const PLUGIN_NAME = 'desktop-e2e-plugin'
const PLUGIN_DISPLAY_NAME = 'Desktop E2E Plugin'

async function createPluginMarketplaceFixture(root) {
  const marketplaceManifestDir = join(root, '.agents', 'plugins')
  const pluginRoot = join(root, 'plugins', PLUGIN_NAME)
  await Promise.all([
    mkdir(marketplaceManifestDir, { recursive: true }),
    mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true }),
    mkdir(join(pluginRoot, 'skills', 'desktop-e2e-skill'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      join(marketplaceManifestDir, 'marketplace.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_MARKETPLACE_NAME,
          interface: { displayName: 'Desktop E2E Marketplace' },
          plugins: [
            {
              name: PLUGIN_NAME,
              source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
            },
          ],
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_NAME,
          interface: {
            displayName: PLUGIN_DISPLAY_NAME,
            shortDescription: 'Exercises the real Wework plugin lifecycle',
          },
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(pluginRoot, 'skills', 'desktop-e2e-skill', 'SKILL.md'),
      `---\nname: desktop-e2e-skill\ndescription: Verifies the installed plugin can be used in chat.\n---\n\nUse this skill to verify the Wework desktop plugin flow.\n`
    ),
  ])
}

function withTimeout(promise, timeoutMs, message) {
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

async function runChecked(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}`))
    })
  })
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Unable to reserve an E2E port')
  await new Promise(resolvePromise => server.close(resolvePromise))
  return address.port
}

async function waitForUrl(url, message, timeoutMs = WORKBENCH_READY_TIMEOUT_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The real service is still starting.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(message)
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  const body = await response.json()
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${url} failed: ${JSON.stringify(body)}`
  )
  return body
}

async function resolveExecutable(configuredPath, fallbackCommand, description) {
  const candidate = configuredPath?.trim()
  if (candidate) {
    const absolutePath = resolve(candidate)
    assert.equal(
      await isExecutable(absolutePath),
      true,
      `${description} is not executable: ${absolutePath}`
    )
    return absolutePath
  }

  const resolved = commandOutput('which', [fallbackCommand])
  assert.equal(await isExecutable(resolved), true, `${description} is not executable: ${resolved}`)
  return resolved
}

async function appendProcessOutput(stream, destination) {
  if (!stream) return
  stream.on('data', chunk => {
    void appendFile(destination, chunk)
  })
}

async function sendPrompt(control, selector, prompt) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('press', selector, { key: 'Enter' })
}

async function prepareCompletedTurnScreenshot(control) {
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let menuClosedAt = null
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('model-selector-menu')) {
      menuClosedAt = null
      await control.command('pointerDown', ACTIVE_COMPOSER_SELECTOR)
    } else {
      menuClosedAt ??= Date.now()
      if (Date.now() - menuClosedAt >= COMPOSER_READY_STABILITY_MS) return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The model selector menu remained open before the verification screenshot')
}

async function waitForSnapshot(
  control,
  predicate,
  message,
  timeoutMs = UI_TIMEOUT_MS,
  selector = 'body'
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', selector))
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function openBottomWorkspaceLauncher(control, description) {
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  const snapshot = await waitForSnapshot(
    control,
    value => value.testIds.includes('workspace-tool-launcher'),
    `${description} did not show the workspace tool launcher`,
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.ok(
    snapshot.testIds.includes('workspace-terminal-card'),
    `${description} did not offer Terminal`
  )
  assert.ok(snapshot.testIds.includes('workspace-ide-card'), `${description} did not offer IDE`)
  assert.equal(
    snapshot.testIds.includes('workspace-terminal-window'),
    false,
    `${description} started a terminal before Terminal was selected`
  )
  return snapshot
}

async function closeBottomWorkspacePanel(control) {
  await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The bottom workspace panel did not close',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

function processGroup(snapshot, groupName) {
  return snapshot.processMemory.groups.find(group => group.group === groupName) ?? null
}

async function captureMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  const webContent = processGroup(snapshot, 'webkit-webcontent')
  assert.ok(webContent, 'The Wework WebContent process was missing from the memory snapshot')
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: webContent.rss_kib,
    physicalFootprintKiB: webContent.physical_footprint_kib,
    pids: webContent.pids,
  }
}

async function verifyMemoryGrowth({ composerSelector, control }) {
  assert.equal(process.platform, 'darwin', 'Desktop memory E2E currently requires macOS')
  control.setScenario('memory')
  const samples = [await captureMemorySample(control, 'baseline')]
  await sendPromptUntilScenarioRequest(control, composerSelector, MEMORY_PROMPT, 'memory')

  let completed = false
  const startedAt = Date.now()
  while (!completed && Date.now() - startedAt < UI_TIMEOUT_MS) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, MEMORY_SAMPLE_INTERVAL_MS))
    samples.push(await captureMemorySample(control, 'streaming'))
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    completed = snapshot.text.includes(MEMORY_COMPLETION_TEXT)
  }
  assert.equal(completed, true, 'The memory E2E response did not complete')

  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    samples.push(await captureMemorySample(control, 'settled'))
  }

  const baseline = samples[0]
  const peak = samples.reduce((largest, sample) =>
    sample.physicalFootprintKiB > largest.physicalFootprintKiB ? sample : largest
  )
  const settledSamples = samples.filter(sample => sample.phase === 'settled')
  const settled = settledSamples.at(-1)
  assert.ok(settled, 'The memory E2E did not capture settled samples')
  const peakGrowthKiB = peak.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledGrowthKiB = settled.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledDriftKiB = settled.physicalFootprintKiB - settledSamples[0].physicalFootprintKiB

  await writeFile(
    join(resultDir, 'memory-growth.json'),
    `${JSON.stringify(
      {
        limits: {
          maxPeakGrowthKiB: MEMORY_MAX_PEAK_GROWTH_KIB,
          maxSettledGrowthKiB: MEMORY_MAX_SETTLED_GROWTH_KIB,
        },
        summary: { peakGrowthKiB, settledGrowthKiB, settledDriftKiB },
        samples,
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  assert.ok(
    peakGrowthKiB <= MEMORY_MAX_PEAK_GROWTH_KIB,
    `WebContent peak physical footprint grew by ${peakGrowthKiB} KiB`
  )
  assert.ok(
    settledGrowthKiB <= MEMORY_MAX_SETTLED_GROWTH_KIB,
    `WebContent settled physical footprint grew by ${settledGrowthKiB} KiB`
  )
  assert.ok(
    settledDriftKiB <= 32 * 1024,
    `WebContent kept growing after completion by ${settledDriftKiB} KiB`
  )
}

async function waitForScenarioRequestCount(control, scenario, expectedCount) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const requestCount = control.scenarioRequests.get(scenario)?.length ?? 0
    if (requestCount >= expectedCount) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The model service did not receive ${expectedCount} ${scenario} requests`)
}

async function waitForFolderPathReady(control, expectedPath) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue === expectedPath && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The device folder picker did not finish loading ${expectedPath}`)
}

async function waitForFolderPickerInitialized(control) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue.length > 0 && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The device folder picker did not finish loading its initial path')
}

async function waitForControlValue(control, selector, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    if ((await control.command('getValue', selector)) === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function captureVerificationScreenshot(control, name, selector = 'body') {
  if (
    process.env.WEWORK_E2E_SCREENSHOTS === 'final' &&
    !name.endsWith('04-task-completed-after-reopen.png')
  ) {
    return null
  }
  const screenshotPath = join(resultDir, name)
  if (process.platform === 'linux') {
    await runChecked('import', ['-window', 'root', screenshotPath])
    return screenshotPath
  }
  let dataUrl
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      dataUrl = await control.command('capture', selector, { timeoutMs: 30_000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    }
  }
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Desktop screenshot did not return PNG data')
  await writeFile(screenshotPath, Buffer.from(dataUrl.slice(prefix.length), 'base64'))
  return screenshotPath
}

async function verifyPluginLifecycle(control, marketplacePath) {
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const initialSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugins-add-custom-marketplace-empty-button') ||
      snapshot.testIds.includes('plugins-add-marketplace-button'),
    'The plugin marketplace controls did not become ready'
  )
  if (initialSnapshot.testIds.includes('plugins-add-custom-marketplace-empty-button')) {
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-empty-button"]')
  } else {
    await control.command('click', '[data-testid="plugins-add-marketplace-button"]')
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-button"]')
  }
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })

  const marketplaceSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(PLUGIN_DISPLAY_NAME) &&
      snapshot.testIds.some(testId => testId.startsWith('plugin-marketplace-row-')),
    'The local plugin marketplace did not expose its plugin'
  )
  const rowTestId = marketplaceSnapshot.testIds.find(testId =>
    testId.startsWith('plugin-marketplace-row-')
  )
  assert.ok(rowTestId, 'The plugin marketplace row did not have a stable test id')
  const pluginId = rowTestId.slice('plugin-marketplace-row-'.length)
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  const actionsSelector = `[data-testid="plugin-marketplace-actions-${pluginId}"]`
  await captureVerificationScreenshot(control, 'plugins-01-marketplace.png')

  await control.command('click', installSelector)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The plugin was not shown as installed after the real app-server request'
  )
  assert.match(
    await control.command('getText', installSelector),
    /Try in chat|在对话中试用/,
    'The installed plugin did not expose its chat action'
  )
  await captureVerificationScreenshot(control, 'plugins-02-installed.png')

  await control.command('click', installSelector)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(PLUGIN_DISPLAY_NAME),
    'Trying the installed plugin did not place its reference in the composer',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(control, 'plugins-03-used-in-chat.png')

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', actionsSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('click', actionsSelector)
  await control.command('click', `[data-testid="plugin-marketplace-uninstall-${pluginId}"]`)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The plugin remained installed after the uninstall request'
  )
  assert.match(
    await control.command('getText', installSelector),
    /Install|安装/,
    'The marketplace did not return to the install state after uninstall'
  )
  await captureVerificationScreenshot(control, 'plugins-04-uninstalled.png')
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function macosSleepInhibitorProcessIds(appProcessId) {
  if (process.platform !== 'darwin') return []
  const output = commandOutput('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match || Number(match[2]) !== appProcessId || match[3] !== '/usr/bin/caffeinate -i') {
      return []
    }
    return [Number(match[1])]
  })
}

async function waitForMacosSleepInhibitor(appProcessId, expectedRunning) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < UI_TIMEOUT_MS) {
    const processIds = macosSleepInhibitorProcessIds(appProcessId)
    if (processIds.length > 0 === expectedRunning) return processIds
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(
    `Timed out waiting for the macOS sleep inhibitor to be ${expectedRunning ? 'running' : 'stopped'}`
  )
}

async function waitForExecutorReadyEvidence(logPath, timeoutMs = UI_TIMEOUT_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(logPath, 'utf8').catch(() => '')
    const processIds = [...content.matchAll(/app IPC stdio ready[^\n]*process_id=(\d+)/g)].map(
      match => Number(match[1])
    )
    if (processIds.length > 0) return { processIds, content }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for executor stdio-ready evidence in ${logPath}`)
}

async function waitForLogPattern(logPath, pattern, timeoutMs = UI_TIMEOUT_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(logPath, 'utf8').catch(() => '')
    if (pattern.test(content)) return content
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for ${pattern} in ${logPath}`)
}

async function reactivateMacApplication(appIdentifier) {
  await runChecked('open', ['-b', appIdentifier])
}

async function triggerModelReloadUntilCloudFailure(control) {
  const failedCloudModelRequest = control.awaitFailedCloudModelRequest()
  for (let attempt = 0; attempt < 10 && control.failedCloudModelRequests === 0; attempt += 1) {
    await control.command('dispatchLocalModelSettingsChanged', '')
    await Promise.race([
      failedCloudModelRequest,
      new Promise(resolvePromise => setTimeout(resolvePromise, 1_000)),
    ])
  }
  await withTimeout(
    failedCloudModelRequest,
    UI_TIMEOUT_MS,
    'The connected desktop app did not retry models after the cloud endpoint began failing'
  )
}

async function sendPromptUntilScenarioRequest(control, selector, prompt, scenario) {
  const scenarioRequest = control.awaitScenarioRequest(scenario)
  await sendPrompt(control, selector, prompt)
  return withTimeout(
    scenarioRequest,
    UI_TIMEOUT_MS,
    `The model service did not receive the ${scenario} request`
  )
}

async function selectE2EModel(control, modelId = MODEL_ID, modelLabel = MODEL_LABEL) {
  const selectedModelText = await control.command(
    'waitFor',
    '[data-testid="model-selector-button"]',
    { timeoutMs: WORKBENCH_READY_TIMEOUT_MS }
  )
  if (selectedModelText.includes(modelLabel)) return

  const targetOptionId = `model-option-${modelId}`
  let optionVisible = false
  for (let attempt = 0; attempt < 6 && !optionVisible; attempt += 1) {
    let menu = JSON.parse(await control.command('snapshot', 'body'))
    if (menu.testIds.includes(targetOptionId)) {
      optionVisible = true
      break
    }
    if (menu.testIds.includes('model-control-menu-model')) {
      await control.command('hover', '[data-testid="model-control-menu-model"]', {
        timeoutMs: UI_TIMEOUT_MS,
      })
    } else {
      await control.command('hover', '[data-testid="model-selector-button"]', {
        timeoutMs: UI_TIMEOUT_MS,
      })
      await control.command('clickWhenEnabled', '[data-testid="model-selector-button"]', {
        stableMs: 100,
        timeoutMs: UI_TIMEOUT_MS,
      })
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
    menu = JSON.parse(await control.command('snapshot', 'body'))
    optionVisible = menu.testIds.includes(targetOptionId)
  }

  assert.ok(optionVisible, `Model option ${modelId} did not become visible`)
  await control.command('waitFor', `[data-testid="model-option-${modelId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  for (const localModel of LOCAL_MODEL_CASES) {
    await control.command('waitFor', `[data-testid="model-option-${localModel.optionId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
  }
  await control.command('click', `[data-testid="model-option-${modelId}"]`)
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    text: modelLabel,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('press', 'body', { key: 'Escape' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('model-selector-menu'),
    'The model selector menu did not close after selecting the E2E model'
  )
}

async function verifyBackgroundTaskWindowLifecycle({
  app,
  appIdentifier,
  composerSelector,
  control,
  executorLogPath,
  setPhase,
}) {
  const lifecycleScreenshotName = name => (LIFECYCLE_ONLY ? name : `window-lifecycle-${name}`)
  setPhase('background-streaming-task')
  control.setScenario('window_lifecycle')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    WINDOW_LIFECYCLE_PROMPT,
    'window_lifecycle'
  )
  await withTimeout(
    control.awaitWindowLifecycleResponseStarted(),
    UI_TIMEOUT_MS,
    'Timed out waiting for the streaming response to start'
  )
  const sleepInhibitorEvidence = []
  if (process.platform === 'darwin') {
    const processIds = await waitForMacosSleepInhibitor(app.pid, true)
    sleepInhibitorEvidence.push({ stage: 'task-running', processIds })
  }
  const runningTaskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-running-')),
    'The running task was not available before closing the window'
  )
  const runningTaskTestId = runningTaskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-running-')
  )
  assert.ok(runningTaskTestId, 'The running task indicator was not found')
  const taskRowTestId = runningTaskTestId.replace(
    'runtime-local-task-running-',
    'runtime-local-task-row-'
  )

  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('01-task-running-before-window-close.png')
  )

  if (process.platform === 'darwin') {
    setPhase('close-to-tray-and-reopen')
    const readyCountBeforeClose = control.readyCount
    const controlClientIdBeforeClose = control.ready?.clientId
    assert.ok(
      controlClientIdBeforeClose,
      'The original WebView did not register a control client ID'
    )
    const readyEvidenceBeforeClose = await waitForExecutorReadyEvidence(executorLogPath)
    const executorProcessId = readyEvidenceBeforeClose.processIds.at(-1)
    assert.ok(executorProcessId, 'The executor stdio-ready log did not include a process ID')
    assert.equal(processIsAlive(app.pid), true, 'The Wework process was not alive before close')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The executor process was not alive before close'
    )

    await control.command('closeMainWindowToTray', 'body')
    await waitForLogPattern(join(resultDir, `wework-tauri-${app.pid}.log`), /windowWillClose:/)
    assert.equal(processIsAlive(app.pid), true, 'Closing to tray terminated the Wework process')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'Closing to tray terminated the executor process'
    )
    const backgroundProcessIds = await waitForMacosSleepInhibitor(app.pid, true)
    sleepInhibitorEvidence.push({
      stage: 'window-closed-to-tray',
      processIds: backgroundProcessIds,
    })

    await reactivateMacApplication(appIdentifier)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened Wework WebView did not reconnect to the desktop controller'
    )
    assert.notEqual(
      control.ready?.clientId,
      controlClientIdBeforeClose,
      'The reopened WebView reused the closed control client identity'
    )
    const reopenedTaskWait = control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const staleClientPoll = await fetch(
      `${control.controlUrl}/commands?clientId=${encodeURIComponent(controlClientIdBeforeClose)}`
    )
    assert.equal(
      staleClientPoll.status,
      204,
      'A closed WebView control client was able to steal a replacement WebView command'
    )
    await reopenedTaskWait
    const readyEvidenceAfterReopen = await waitForExecutorReadyEvidence(executorLogPath)
    assert.deepEqual(
      readyEvidenceAfterReopen.processIds,
      [executorProcessId],
      'Reopening the window spawned or attached to a different executor process'
    )
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The original executor process was not alive after reopening the window'
    )
    await writeFile(
      join(resultDir, 'stdio-lifecycle-verification.json'),
      `${JSON.stringify(
        {
          appProcessId: app.pid,
          executorProcessId,
          executorReadyLogCount: readyEvidenceAfterReopen.processIds.length,
          webviewReadyCountBeforeClose: readyCountBeforeClose,
          webviewReadyCountAfterReopen: control.readyCount,
          appAliveAfterReopen: processIsAlive(app.pid),
          executorAliveAfterReopen: processIsAlive(executorProcessId),
        },
        null,
        2
      )}\n`
    )
    await captureVerificationScreenshot(
      control,
      lifecycleScreenshotName('02-window-reopened-task-still-running.png')
    )
  }

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('message-user') && snapshot.text.includes(WINDOW_LIFECYCLE_PROMPT),
    'The reopened task did not restore its running user message',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('03-running-task-after-reopen.png')
  )
  control.releaseWindowLifecycleResponse()
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('message-assistant') &&
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT),
    'The reopened task did not render its completed assistant message',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  if (process.platform === 'darwin') {
    await waitForSnapshot(
      control,
      snapshot =>
        !snapshot.testIds.includes('thinking-indicator') &&
        !snapshot.testIds.includes(runningTaskTestId),
      'The reopened task did not settle after its persisted transcript completed',
      UI_TIMEOUT_MS,
      ACTIVE_WORKBENCH_SELECTOR
    )
  }
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('04-task-completed-after-reopen.png')
  )
  if (process.platform === 'darwin') {
    const processIds = await waitForMacosSleepInhibitor(app.pid, false)
    sleepInhibitorEvidence.push({ stage: 'task-completed', processIds })
    await writeFile(
      join(resultDir, 'sleep-inhibitor-lifecycle-verification.json'),
      `${JSON.stringify({ appProcessId: app.pid, stages: sleepInhibitorEvidence }, null, 2)}\n`
    )
  }
}

async function attachAndSendOnlyFile(control, composerSelector) {
  await control.command('dropFile', composerSelector, {
    filename: ATTACHMENT_ONLY_FILENAME,
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
}

async function verifyAttachmentOnlySidebarLifecycle({ appIdentifier, composerSelector, control }) {
  control.setScenario('attachment_only')

  await attachAndSendOnlyFile(control, composerSelector)
  await captureVerificationScreenshot(control, '01-attachment-only-first-submitted.png')
  await control.awaitScenarioRequestCount('attachment_only', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const firstSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-')).length >= 1,
    'The first attachment-only task did not appear in the sidebar'
  )
  const firstRows = firstSnapshot.testIds.filter(testId =>
    testId.startsWith('runtime-local-task-row-')
  )
  await captureVerificationScreenshot(control, '02-attachment-only-first-completed.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await attachAndSendOnlyFile(control, composerSelector)
  await captureVerificationScreenshot(control, '03-attachment-only-second-submitted.png')
  await control.awaitScenarioRequestCount('attachment_only', 2)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
    timeoutMs: UI_TIMEOUT_MS,
  })

  const twoTaskSnapshot = await waitForSnapshot(
    control,
    snapshot => {
      const rows = snapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
      return firstRows.every(testId => rows.includes(testId)) && rows.length >= firstRows.length + 1
    },
    'A same-title attachment-only task disappeared after the authoritative sidebar refresh'
  )
  const expectedRows = twoTaskSnapshot.testIds.filter(testId =>
    testId.startsWith('runtime-local-task-row-')
  )
  await captureVerificationScreenshot(control, '04-attachment-only-two-tasks-after-refresh.png')

  if (process.platform === 'darwin') {
    const readyCountBeforeClose = control.readyCount
    await control.command('closeMainWindowToTray', 'body')
    await reactivateMacApplication(appIdentifier)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened Wework WebView did not reconnect during attachment-only verification'
    )
  } else {
    await control.command('navigate', '/')
  }

  for (const testId of expectedRows) {
    await control.command('waitFor', `[data-testid="${testId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  await captureVerificationScreenshot(control, '05-attachment-only-two-tasks-after-reopen.png')

  const requests = control.scenarioRequests.get('attachment_only') ?? []
  assert.equal(requests.length, 2, 'Attachment-only flow did not send exactly two model requests')
  for (const request of requests) {
    const serialized = JSON.stringify(request.body)
    assert.ok(
      serialized.includes(ATTACHMENT_ONLY_FILENAME),
      'The attachment filename was not forwarded to the real Codex request'
    )
  }
}

async function verifySideChatAttachmentIsolation({ control }) {
  const sideChatSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-panel"]`
  const rightPanelShellSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
  const mainComposerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
  const sideComposerSelector = `${sideChatSelector} [data-testid="chat-message-input"]`

  control.setScenario('initial')
  await sendPrompt(control, ACTIVE_COMPOSER_SELECTOR, TASK_PROMPT)
  await control.awaitScenarioRequestCount('initial', 1)
  control.releaseInitialToolExecution()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  const taskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
    'The completed main conversation did not appear in the task sidebar'
  )
  const taskRowTestId = taskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-row-')
  )
  assert.ok(taskRowTestId, 'The completed main conversation did not expose a task row')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-empty-composer-frame"]`,
    { timeoutMs: UI_TIMEOUT_MS }
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    }
  )
  control.setScenario('side_chat_attachment')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('click', '[data-testid="right-workspace-chat-option"]')
  await control.command('waitFor', sideComposerSelector, { timeoutMs: UI_TIMEOUT_MS })

  const workbenchWidth = Number.parseFloat(
    await control.command('getStyle', ACTIVE_WORKBENCH_SELECTOR, { value: 'width' })
  )
  const panelWidthStyle = await control.command('getInlineStyle', rightPanelShellSelector, {
    value: 'width',
  })
  const chatWidthMatch = panelWidthStyle.match(/^calc\(100% - ([\d.]+)px\)$/)
  assert.ok(chatWidthMatch, `Unexpected right-panel width style: ${panelWidthStyle}`)
  const panelWidth = workbenchWidth - Number.parseFloat(chatWidthMatch[1])
  assert.ok(
    panelWidth >= 400 && panelWidth <= 440,
    `The temporary-chat-only right panel was ${panelWidth}px wide instead of about 420px`
  )
  await captureVerificationScreenshot(control, '01-side-chat-compact-width.png')

  await control.command('dropFile', sideComposerSelector, {
    filename: SIDE_CHAT_FILENAME,
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('attachment-badge') &&
      !snapshot.testIds.includes('uploading-attachment-badge'),
    'The side-chat attachment did not finish uploading',
    UI_TIMEOUT_MS,
    sideChatSelector
  )
  const mainBeforeSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
  assert.equal(
    mainBeforeSend.testIds.includes('attachment-badge'),
    false,
    'Uploading in the side chat leaked an attachment into the main composer'
  )
  await captureVerificationScreenshot(control, '02-side-chat-attachment-isolated.png')

  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_PROMPT })
  assert.equal(
    await control.command('getValue', sideComposerSelector),
    SIDE_CHAT_PROMPT,
    'The side-chat prompt did not reach the isolated composer'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, COMPOSER_READY_STABILITY_MS))
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.awaitScenarioRequestCount('side_chat_attachment', 1)
  await control.command('waitFor', `${sideChatSelector} [data-testid="message-assistant"]`, {
    text: SIDE_CHAT_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  const sideAfterSend = JSON.parse(await control.command('snapshot', sideChatSelector))
  assert.equal(
    sideAfterSend.testIds.includes('attachment-badge'),
    false,
    'The sent side-chat attachment was not cleared from its composer'
  )
  const mainAfterSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
  assert.equal(
    mainAfterSend.testIds.includes('attachment-badge'),
    false,
    'Sending the side chat leaked an attachment into the main composer'
  )
  await captureVerificationScreenshot(control, '03-side-chat-sent-main-clean.png')

  const requests = control.scenarioRequests.get('side_chat_attachment') ?? []
  assert.equal(requests.length, 1, 'The side chat did not send exactly one model request')
  const requestText = JSON.stringify(requests[0].body)
  assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat prompt was not forwarded')
  assert.ok(requestText.includes(SIDE_CHAT_FILENAME), 'The side-chat attachment was not forwarded')
}

async function verifyReconnectRecovery({ composerSelector, control }) {
  control.setScenario('reconnect')
  await sendPromptUntilScenarioRequest(control, composerSelector, RECONNECT_PROMPT, 'reconnect')
  await withTimeout(
    control.awaitReconnectResponseStarted(),
    UI_TIMEOUT_MS,
    'The reconnect response stream did not start'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
    { timeoutMs: UI_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-01-streaming.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.disconnectReconnectResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-reconnecting-status"]`,
    { timeoutMs: UI_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-02-reconnecting.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  await withTimeout(
    control.awaitScenarioRequestCount('reconnect', 2),
    UI_TIMEOUT_MS,
    'Codex did not retry the disconnected response stream'
  )
  control.releaseReconnectResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: RECONNECT_COMPLETION_TEXT, timeoutMs: UI_TIMEOUT_MS }
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('runtime-reconnecting-status'),
    false,
    'The reconnecting status remained after model output recovered'
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-03-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

function createSse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function codexRequestKind(body) {
  const metadata = body.client_metadata?.['x-codex-turn-metadata']
  if (typeof metadata !== 'string') return null

  try {
    return JSON.parse(metadata).request_kind ?? null
  } catch {
    return null
  }
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function responseFailed(id, message) {
  return {
    type: 'response.failed',
    response: {
      id,
      status: 'failed',
      error: { code: 'context_length_exceeded', message },
    },
  }
}

function functionCall(callId, name, argumentsValue) {
  return [
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
      },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    },
  ]
}

function customToolCall(callId, name, input) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input,
    },
  }
}

function assistantMessage(text) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      role: 'assistant',
      id: 'wework-e2e-message',
      content: [{ type: 'output_text', text }],
    },
  }
}

function streamingMarkdownReport() {
  const section = index =>
    [
      `### Memory section ${index}`,
      '',
      '| Metric | Value |',
      '| --- | ---: |',
      `| Section | ${index} |`,
      '| Rendering | Streaming Markdown |',
      '',
      '```ts',
      `export const memorySection${index} = { enabled: true, index: ${index} }`,
      '```',
      '',
      'This section exercises incremental Markdown parsing, syntax highlighting, React reconciliation, and WebKit layout allocation.',
      '',
    ].join('\n')
  return `${Array.from({ length: 80 }, (_, index) => section(index + 1)).join('\n')}\n${MEMORY_COMPLETION_TEXT}`
}

function streamingTextEvents(id, text) {
  const itemId = `${id}-message`
  const chunks = text.match(/[\s\S]{1,48}/g) ?? []
  return {
    chunks,
    start: [
      responseCreated(id),
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      },
      {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ],
    finish: [
      {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      },
      responseCompleted(id),
    ],
    itemId,
  }
}

function localProtocolCase(modelId) {
  return LOCAL_MODEL_CASES.find(model => model.modelId === modelId) ?? null
}

function localProtocolPrompt(model, phase) {
  return `WEWORK_LOCAL_MODEL_${model.protocol.toUpperCase()}_${phase}`
}

function localProtocolArtifact(model) {
  return `wework-local-${model.protocol}.txt`
}

function localProtocolArtifactContent(model) {
  return `WEWORK_LOCAL_${model.protocol.toUpperCase()}_APPLY_PATCH`
}

function localProtocolPatch(model) {
  return [
    '*** Begin Patch',
    `*** Add File: ${localProtocolArtifact(model)}`,
    `+${localProtocolArtifactContent(model)}`,
    '*** End Patch',
  ].join('\n')
}

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
    })
    request.once('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.once('error', reject)
  })
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function requestContainsToolOutput(request) {
  const input = JSON.stringify(request.input ?? [])
  return input.includes('function_call_output') || input.includes('custom_tool_call_output')
}

function requestAdvertisesShellTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  return tools.some(tool => tool?.name === 'exec_command' || tool?.name === 'shell_command')
}

function selectTool(request, name, argumentsValue) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
  assert.ok(names.has(name), `Real Codex did not advertise ${name}: ${[...names].join(', ')}`)
  return { name, arguments: argumentsValue }
}

function selectShellTool(request, workspacePath) {
  const command = 'pwd'
  const tools = Array.isArray(request.tools) ? request.tools : []
  if (tools.some(tool => tool?.name === 'exec_command')) {
    return selectTool(request, 'exec_command', {
      cmd: command,
      workdir: workspacePath,
      yield_time_ms: 1000,
    })
  }
  if (tools.some(tool => tool?.name === 'shell_command')) {
    return selectTool(request, 'shell_command', {
      command,
      workdir: workspacePath,
      timeout_ms: 10_000,
    })
  }
  throw new Error('Real Codex did not advertise a supported shell tool')
}

function selectApplyPatchTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  assert.ok(
    tools.some(tool => tool?.name === 'apply_patch'),
    `Real Codex did not advertise apply_patch: ${tools
      .map(tool => tool?.name)
      .filter(Boolean)
      .join(', ')}`
  )
  return [
    '*** Begin Patch',
    `*** Add File: ${ARTIFACT_NAME}`,
    `+${ARTIFACT_CONTENT}`,
    '*** End Patch',
  ].join('\n')
}

function selectCloudApplyPatchTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  assert.ok(
    tools.some(tool => tool?.name === 'apply_patch'),
    'Real cloud Codex did not advertise apply_patch'
  )
  return [
    '*** Begin Patch',
    `*** Add File: ${CLOUD_ARTIFACT_NAME}`,
    `+${CLOUD_ARTIFACT_CONTENT}`,
    '*** End Patch',
  ].join('\n')
}

function selectViewImageTool(request, workspacePath) {
  return selectTool(request, 'view_image', {
    path: join(workspacePath, IMAGE_ARTIFACT_NAME),
  })
}

class RealCloudEnvironment {
  constructor({ codexBinary, executorBinary, modelServerUrl, workspacePath }) {
    this.codexBinary = codexBinary
    this.executorBinary = executorBinary
    this.modelServerUrl = modelServerUrl
    this.workspacePath = workspacePath
  }

  async start() {
    this.redisPort = await reservePort()
    this.backendPort = await reservePort()
    this.backendUrl = `http://127.0.0.1:${this.backendPort}`
    this.databasePath = join(resultDir, 'cloud-backend.sqlite3')
    this.backendLogPath = join(resultDir, 'cloud-backend.log')
    this.redisLogPath = join(resultDir, 'cloud-redis.log')
    this.remoteExecutorLogPath = join(resultDir, 'cloud-executor.log')

    this.redis = spawn(
      'redis-server',
      ['--port', String(this.redisPort), '--save', '', '--appendonly', 'no'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await Promise.all([
      appendProcessOutput(this.redis.stdout, this.redisLogPath),
      appendProcessOutput(this.redis.stderr, this.redisLogPath),
    ])

    const backendEnv = {
      ...process.env,
      DATABASE_URL: `sqlite:///${this.databasePath}`,
      REDIS_URL: `redis://127.0.0.1:${this.redisPort}/0`,
      SECRET_KEY: `wework-desktop-e2e-${process.pid}`,
      INTERNAL_SERVICE_TOKEN: `wework-desktop-e2e-internal-${process.pid}`,
      DB_AUTO_MIGRATE: 'false',
      INIT_DATA_ENABLED: 'true',
    }
    await runChecked('uv', ['run', 'alembic', 'upgrade', 'head'], {
      cwd: join(repoDir, 'backend'),
      env: backendEnv,
    })
    this.backend = spawn(
      'uv',
      ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.backendPort)],
      {
        cwd: join(repoDir, 'backend'),
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    await Promise.all([
      appendProcessOutput(this.backend.stdout, this.backendLogPath),
      appendProcessOutput(this.backend.stderr, this.backendLogPath),
    ])
    await waitForUrl(
      `${this.backendUrl}/api/docs`,
      `Real cloud backend did not start; see ${this.backendLogPath}`
    )

    const password = `wework-desktop-e2e-${process.pid}`
    const setup = await fetchJson(`${this.backendUrl}/api/auth/admin-password/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    this.authToken = setup.access_token
    assert.ok(this.authToken, 'Real cloud backend did not return an authentication token')

    const remoteHome = join(resultDir, 'cloud-executor-home')
    const remoteCodexHome = join(remoteHome, 'codex')
    await writeCodexConfig(remoteCodexHome, this.modelServerUrl)
    const remoteEnv = {
      ...process.env,
      CODEX_BIN: this.codexBinary,
      CODEX_HOME: remoteCodexHome,
      HOME: remoteHome,
      WEGENT_CODEX_HOME: remoteCodexHome,
      WEGENT_EXECUTOR_HOME: remoteHome,
      WEGENT_EXECUTOR_LOG_DIR: resultDir,
      WEGENT_EXECUTOR_LOG_FILE: 'cloud-executor-runtime.log',
      EXECUTOR_MODE: 'local',
      WEGENT_BACKEND_URL: this.backendUrl,
      WEGENT_AUTH_TOKEN: this.authToken,
      DEVICE_ID: CLOUD_DEVICE_ID,
      DEVICE_NAME: 'Wework E2E Cloud Device',
      DEVICE_TYPE: 'remote',
      BIND_SHELL: 'claudecode',
      LOCAL_WORKSPACE_ROOT: dirname(this.workspacePath),
      WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
    }
    delete remoteEnv.WEGENT_APP_IPC_DEVICE_ID
    this.remoteExecutor = spawn(this.executorBinary, [], {
      cwd: weworkDir,
      env: remoteEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    await Promise.all([
      appendProcessOutput(this.remoteExecutor.stdout, this.remoteExecutorLogPath),
      appendProcessOutput(this.remoteExecutor.stderr, this.remoteExecutorLogPath),
    ])
    await this.waitForDevice()
  }

  async waitForDevice() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
      })
      if (response.ok) {
        const devices = await response.json()
        const device = devices.items?.find(item => item.device_id === CLOUD_DEVICE_ID)
        if (device?.status === 'online') return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error(`Real cloud executor did not register; see ${this.remoteExecutorLogPath}`)
  }

  async waitForWorkspaceRemoved(workspacePath) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < UI_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/runtime-work`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
      })
      if (response.ok) {
        const work = await response.json()
        const stillPresent = work.workspaces?.some(
          workspace => workspace.workspacePath === workspacePath
        )
        if (!stillPresent) return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error('The real cloud backend still returned the removed project')
  }

  async cancelRunningTasks() {
    if (!this.backendUrl || !this.authToken) return
    const work = await fetchJson(`${this.backendUrl}/api/runtime-work`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const workspaces = [
      ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
      ...(work.chats ?? []),
    ]
    const runningTasks = workspaces.flatMap(workspace =>
      (workspace.tasks ?? [])
        .filter(task => task.running)
        .map(task => ({
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          workspacePath: task.workspacePath,
        }))
    )
    await Promise.all(
      runningTasks.map(address =>
        fetchJson(`${this.backendUrl}/api/runtime-work/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(address),
        })
      )
    )
  }

  async stop() {
    try {
      await this.cancelRunningTasks()
    } catch (error) {
      await appendFile(
        this.remoteExecutorLogPath,
        `Cloud E2E cleanup could not cancel running tasks: ${String(error)}\n`
      )
    }
    await stopProcessGroup(this.remoteExecutor)
    await stopProcess(this.backend)
    await stopProcess(this.redis)
  }
}

class DesktopE2EServer {
  constructor(workspacePath, cloudWorkspacePath = workspacePath, desktopScenario = null) {
    this.workspacePath = workspacePath
    this.cloudWorkspacePath = cloudWorkspacePath
    this.desktopScenario = desktopScenario
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => this.fail(error, response))
    })
    this.desktopScenario?.attachServer?.(this.server)
    this.controlServer = createServer((request, response) => {
      void this.handleControl(request, response).catch(error => this.fail(error, response))
    })
    this.fatalError = null
    this.fatalErrorPromise = new Promise((_, reject) => {
      this.rejectFatalError = reject
    })
    // A guarded operation observes this rejection; this handler prevents Node from
    // reporting it as unhandled in the small window before that operation starts.
    void this.fatalErrorPromise.catch(() => {})
    this.ready = null
    this.readyResolver = null
    this.readyCount = 0
    this.activeControlClientId = null
    this.readyWaiters = []
    this.commandQueue = []
    this.commandResults = new Map()
    this.commandHistory = []
    this.modelRequests = []
    this.catalogRequests = []
    this.blockedCloudRequests = []
    this.blockedCloudResponses = new Set()
    this.blockedCloudWaiters = []
    this.failCloudModels = false
    this.failedCloudModelRequests = 0
    this.failedCloudModelWaiter = null
    this.scenario = 'initial'
    this.modelStage = 'initial'
    this.memoryStage = 'initial'
    this.cloudModelStage = 'initial'
    this.toolLessPrewarmHandled = false
    this.memoryToolLessPrewarmHandled = false
    this.cloudToolLessPrewarmHandled = false
    this.toolOutput = null
    this.initialToolRelease = new Promise(resolvePromise => {
      this.releaseInitialTool = resolvePromise
    })
    this.retryCompletionRelease = new Promise(resolvePromise => {
      this.releaseRetryCompletion = resolvePromise
    })
    this.requestUserInputRelease = new Promise(resolvePromise => {
      this.releaseRequestUserInput = resolvePromise
    })
    this.requestUserInputResponseWritten = new Promise(resolvePromise => {
      this.resolveRequestUserInputResponseWritten = resolvePromise
    })
    this.reconnectDisconnectRelease = new Promise(resolvePromise => {
      this.releaseReconnectDisconnect = resolvePromise
    })
    this.reconnectResponseStarted = new Promise(resolvePromise => {
      this.resolveReconnectResponseStarted = resolvePromise
    })
    this.reconnectCompletionRelease = new Promise(resolvePromise => {
      this.releaseReconnectCompletion = resolvePromise
    })
    this.windowLifecycleRelease = new Promise(resolvePromise => {
      this.releaseWindowLifecycle = resolvePromise
    })
    this.windowLifecycleResponseStarted = new Promise(resolvePromise => {
      this.resolveWindowLifecycleResponseStarted = resolvePromise
    })
    this.scenarioRequests = new Map()
    this.scenarioWaiters = new Map()
    this.localProtocolStates = new Map(
      LOCAL_MODEL_CASES.map(model => [model.protocol, { stage: 'initial', requests: [] }])
    )
  }

  async start() {
    await Promise.all([this.listen(this.server), this.listen(this.controlServer)])
    const address = this.server.address()
    const controlAddress = this.controlServer.address()
    assert.ok(address && typeof address !== 'string', 'Desktop E2E server did not bind a TCP port')
    assert.ok(
      controlAddress && typeof controlAddress !== 'string',
      'Desktop E2E control server did not bind a TCP port'
    )
    this.url = `http://127.0.0.1:${address.port}`
    this.controlUrl = `http://127.0.0.1:${controlAddress.port}`
  }

  async listen(server) {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolvePromise()
      })
    })
  }

  async close() {
    for (const response of this.blockedCloudResponses) response.destroy()
    this.blockedCloudResponses.clear()
    this.desktopScenario?.close?.()
    this.server.closeAllConnections?.()
    this.controlServer.closeAllConnections?.()
    await Promise.all([
      new Promise(resolvePromise => this.server.close(resolvePromise)),
      new Promise(resolvePromise => this.controlServer.close(resolvePromise)),
    ])
  }

  awaitReady() {
    if (this.ready) return this.guard(Promise.resolve(this.ready))
    return this.guard(
      new Promise(resolvePromise => {
        this.readyResolver = resolvePromise
      })
    )
  }

  awaitReadyAfter(readyCount) {
    if (this.readyCount > readyCount) return this.guard(Promise.resolve(this.ready))
    return this.guard(
      new Promise(resolvePromise => {
        this.readyWaiters.push({ readyCount, resolve: resolvePromise })
      })
    )
  }

  awaitBlockedCloudRequest(pathname) {
    const request = this.blockedCloudRequests.find(item => item.pathname === pathname)
    if (request) return this.guard(Promise.resolve(request))
    return this.guard(
      new Promise(resolvePromise => {
        this.blockedCloudWaiters.push({ pathname, resolve: resolvePromise })
      })
    )
  }

  fail(error, response) {
    if (!response.headersSent) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    } else if (!response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined)
    }
    if (this.fatalError) return
    this.fatalError = error instanceof Error ? error : new Error(String(error))
    this.rejectFatalError(this.fatalError)
    for (const pending of this.commandResults.values()) pending.reject(this.fatalError)
    this.commandResults.clear()
  }

  guard(promise) {
    if (this.fatalError) return Promise.reject(this.fatalError)
    return Promise.race([promise, this.fatalErrorPromise])
  }

  blockCloudRequest(request, response, url) {
    const blockedRequest = {
      method: request.method,
      pathname: url.pathname,
      search: url.search,
    }
    this.blockedCloudRequests.push(blockedRequest)
    this.blockedCloudResponses.add(response)
    response.once('close', () => this.blockedCloudResponses.delete(response))

    const remainingWaiters = []
    for (const waiter of this.blockedCloudWaiters) {
      if (waiter.pathname === url.pathname) {
        waiter.resolve(blockedRequest)
      } else {
        remainingWaiters.push(waiter)
      }
    }
    this.blockedCloudWaiters = remainingWaiters
  }

  failBlockedCloudModels() {
    this.failCloudModels = true
    const failedRequests = this.blockedCloudResponses.size
    for (const response of this.blockedCloudResponses) {
      json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
    }
    this.blockedCloudResponses.clear()
    this.failedCloudModelRequests += failedRequests
    if (failedRequests > 0) {
      this.failedCloudModelWaiter?.()
      this.failedCloudModelWaiter = null
    }
  }

  awaitFailedCloudModelRequest() {
    if (this.failedCloudModelRequests > 0) return this.guard(Promise.resolve())
    return this.guard(
      new Promise(resolvePromise => {
        this.failedCloudModelWaiter = resolvePromise
      })
    )
  }

  setScenario(scenario) {
    assert.ok(
      [
        'initial',
        'follow_up',
        'request_user_input',
        'window_lifecycle',
        'cancellation',
        'retry',
        'reconnect',
        'fresh_chat',
        'attachment_only',
        'memory',
        'side_chat_attachment',
        'cloud_initial',
        'cloud_follow_up',
      ].includes(scenario),
      `Unknown desktop E2E scenario: ${scenario}`
    )
    this.scenario = scenario
  }

  recordScenarioRequest(scenario, request) {
    const requests = this.scenarioRequests.get(scenario) ?? []
    requests.push(request)
    this.scenarioRequests.set(scenario, requests)
    const waiter = this.scenarioWaiters.get(scenario)
    if (waiter) {
      this.scenarioWaiters.delete(scenario)
      waiter(request)
    }
  }

  awaitScenarioRequest(scenario) {
    const request = this.scenarioRequests.get(scenario)?.at(-1)
    if (request) return this.guard(Promise.resolve(request))
    return this.guard(
      new Promise(resolvePromise => {
        this.scenarioWaiters.set(scenario, resolvePromise)
      })
    )
  }

  async awaitScenarioRequestCount(scenario, count) {
    const waitForCount = (async () => {
      while ((this.scenarioRequests.get(scenario)?.length ?? 0) < count) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      return this.scenarioRequests.get(scenario).at(-1)
    })()
    return withTimeout(
      this.guard(waitForCount),
      UI_TIMEOUT_MS,
      `Timed out waiting for ${count} ${scenario} scenario requests`
    )
  }

  releaseInitialToolExecution() {
    this.releaseInitialTool()
  }

  releaseRetryResponse() {
    this.releaseRetryCompletion()
  }

  releaseRequestUserInputResponse() {
    this.releaseRequestUserInput()
    return this.guard(this.requestUserInputResponseWritten)
  }

  awaitReconnectResponseStarted() {
    return this.guard(this.reconnectResponseStarted)
  }

  disconnectReconnectResponse() {
    this.releaseReconnectDisconnect()
  }

  releaseReconnectResponse() {
    this.releaseReconnectCompletion()
  }

  awaitWindowLifecycleResponseStarted() {
    return this.guard(this.windowLifecycleResponseStarted)
  }

  releaseWindowLifecycleResponse() {
    this.releaseWindowLifecycle()
  }

  async command(action, selector, options = {}) {
    assert.ok(this.activeControlClientId, 'No active desktop control client is registered')
    const id = randomUUID()
    const command = { id, action, selector, ...options }
    const clientId = this.activeControlClientId
    const result = new Promise((resolvePromise, reject) => {
      this.commandResults.set(id, { clientId, resolve: resolvePromise, reject })
    })
    this.commandQueue.push({ clientId, command })
    return withTimeout(
      this.guard(result),
      options.timeoutMs ?? UI_TIMEOUT_MS,
      `Timed out running UI action ${action} for ${selector}`
    )
  }

  async handleControl(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.controlUrl)
    if (await this.handleControlRoute(request, response, url)) return
    json(response, 404, {
      error: `No Desktop E2E control route for ${request.method} ${url.pathname}`,
    })
  }

  async handle(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.url)
    if (await this.handleControlRoute(request, response, url)) return
    if (await this.desktopScenario?.handleHttp?.(request, response, url)) return

    if (request.method === 'GET' && url.pathname === '/api/users/me') {
      json(response, 200, {
        id: 9001,
        user_name: 'wework-desktop-e2e-cloud-user',
        email: 'desktop-e2e@wework.local',
      })
      return
    }

    if (request.method === 'GET' && url.pathname === BLOCKED_CLOUD_MODEL_PATH) {
      if (this.failCloudModels) {
        this.failedCloudModelRequests += 1
        this.failedCloudModelWaiter?.()
        this.failedCloudModelWaiter = null
        json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
        return
      }
      this.blockCloudRequest(request, response, url)
      return
    }

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      this.catalogRequests.push({
        authorization: request.headers.authorization ?? null,
        ifNoneMatch: request.headers['if-none-match'] ?? null,
        pathname: url.pathname,
        search: url.search,
      })
      assert.equal(
        request.headers.authorization,
        `Bearer ${MODEL_API_KEY}`,
        'The local catalog router did not forward the configured model API key'
      )
      response.setHeader('ETag', '"wework-desktop-e2e-models-v1"')
      json(response, 200, {
        models: [],
      })
      return
    }

    const modelProtocol =
      url.pathname === '/v1/responses' || url.pathname === '/responses'
        ? 'responses'
        : url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions'
          ? 'chat'
          : url.pathname === '/v1/messages' || url.pathname === '/messages'
            ? 'anthropic'
            : null
    if (request.method === 'POST' && modelProtocol) {
      await this.handleModelResponse(request, response, modelProtocol)
      return
    }

    json(response, 404, { error: `No Desktop E2E route for ${request.method} ${url.pathname}` })
  }

  async handleControlRoute(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/ready') {
      const ready = await readRequestBody(request)
      assert.equal(typeof ready.clientId, 'string', 'Desktop control client ID is required')
      assert.ok(ready.clientId.length > 0, 'Desktop control client ID cannot be empty')
      const previousClientId = this.activeControlClientId
      this.activeControlClientId = ready.clientId
      if (previousClientId && previousClientId !== ready.clientId) {
        const replacementError = new Error(
          `Desktop control client ${previousClientId} was replaced by ${ready.clientId}`
        )
        this.commandQueue = this.commandQueue.filter(item => item.clientId !== previousClientId)
        for (const [id, pending] of this.commandResults) {
          if (pending.clientId !== previousClientId) continue
          this.commandResults.delete(id)
          pending.reject(replacementError)
        }
      }
      this.ready = ready
      this.readyCount += 1
      this.readyResolver?.(ready)
      this.readyResolver = null
      const remainingWaiters = []
      for (const waiter of this.readyWaiters) {
        if (this.readyCount > waiter.readyCount) {
          waiter.resolve(ready)
        } else {
          remainingWaiters.push(waiter)
        }
      }
      this.readyWaiters = remainingWaiters
      json(response, 200, { ok: true })
      return true
    }

    if (request.method === 'GET' && url.pathname === '/commands') {
      const clientId = url.searchParams.get('clientId')
      if (!clientId || clientId !== this.activeControlClientId) {
        response.writeHead(204)
        response.end()
        return true
      }
      const commandIndex = this.commandQueue.findIndex(item => item.clientId === clientId)
      if (commandIndex >= 0) {
        const [{ command }] = this.commandQueue.splice(commandIndex, 1)
        this.commandHistory.push({
          ...command,
          clientId,
          deliveredAt: new Date().toISOString(),
        })
        json(response, 200, command)
        return true
      }
      response.writeHead(204)
      response.end()
      return true
    }

    if (request.method === 'GET' && url.pathname === '/control-tick') {
      setTimeout(() => {
        response.writeHead(204)
        response.end()
      }, 50)
      return true
    }

    if (request.method === 'POST' && url.pathname === '/results') {
      const result = await readRequestBody(request)
      const pending = this.commandResults.get(result.id)
      if (!pending) {
        json(response, 404, { error: `Unknown command ${result.id}` })
        return true
      }
      if (result.clientId !== pending.clientId || result.clientId !== this.activeControlClientId) {
        json(response, 409, {
          error: `Command ${result.id} belongs to a different desktop control client`,
        })
        return true
      }
      this.commandResults.delete(result.id)
      if (result.ok) {
        pending.resolve(result.value ?? '')
      } else {
        pending.reject(new Error(result.error ?? `UI action ${result.id} failed`))
      }
      json(response, 200, { ok: true })
      return true
    }
    return false
  }

  async handleModelResponse(request, response, protocol) {
    const body = await readRequestBody(request)
    const authorization = request.headers.authorization ?? null
    const modelRequest = { authorization, body, scenario: this.scenario }
    this.modelRequests.push(modelRequest)
    if (authorization !== `Bearer ${MODEL_API_KEY}`) {
      json(response, 401, { error: 'The Desktop E2E model API key was not forwarded by Codex' })
      return
    }

    const localModel = localProtocolCase(body.model)
    if (localModel) {
      assert.equal(
        protocol,
        localModel.protocol,
        `Local model ${body.model} reached the wrong ${protocol} endpoint`
      )
      this.handleLocalProtocolResponse(response, localModel, body, request.headers)
      return
    }

    const responseId = `wework-e2e-response-${this.modelRequests.length}`
    const requestKind = codexRequestKind(body)
    if (requestKind === 'compaction') {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage('Desktop E2E context compaction completed.'),
        responseCompleted(responseId),
      ])
      return
    }

    if (requestKind === 'prewarm') {
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    // Codex CLI 0.144 can prewarm a custom Responses provider before adding
    // tool definitions or request metadata. It must not advance the task loop.
    if (
      this.scenario === 'initial' &&
      this.modelStage === 'initial' &&
      !this.toolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.toolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'cloud_initial' &&
      this.cloudModelStage === 'initial' &&
      !this.cloudToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.cloudToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'memory' &&
      this.memoryStage === 'initial' &&
      !this.memoryToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.memoryToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (this.scenario === 'initial' && this.modelStage === 'initial') {
      this.recordScenarioRequest('initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(TASK_PROMPT),
        'The real Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      const patch = selectApplyPatchTool(body)
      const image = selectViewImageTool(body, this.workspacePath)
      this.modelStage = 'awaiting_tool_output'
      await this.initialToolRelease
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-e2e-tool-call', tool.name, tool.arguments),
        ...functionCall('wework-e2e-view-image', image.name, image.arguments),
        customToolCall('wework-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'initial') {
      assert.equal(
        this.modelStage,
        'awaiting_tool_output',
        `Unexpected desktop E2E model stage: ${this.modelStage}`
      )
      this.recordScenarioRequest('initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report its tool output to the model service'
      )
      this.toolOutput = JSON.stringify(body.input)
      this.modelStage = 'complete'
      // Let the workbench commit the completed tool items before the final response
      // triggers a transcript refresh. Real providers have network latency here; an
      // immediate mock response can otherwise race the live image-view rendering.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'memory' && this.memoryStage === 'initial') {
      this.recordScenarioRequest('memory', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(MEMORY_PROMPT),
        'The real Codex request did not contain the memory E2E prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      this.memoryStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-memory-tool-call', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'memory') {
      this.recordScenarioRequest('memory', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report the memory E2E tool output'
      )
      this.memoryStage = 'streaming'
      await this.writeStreamingMarkdown(response, responseId, streamingMarkdownReport())
      this.memoryStage = 'complete'
      return
    }

    if (this.scenario === 'cloud_initial' && this.cloudModelStage === 'initial') {
      this.recordScenarioRequest('cloud_initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_TASK_PROMPT),
        'The real cloud Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.cloudWorkspacePath)
      const patch = selectCloudApplyPatchTool(body)
      this.cloudModelStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-cloud-e2e-tool-call', tool.name, tool.arguments),
        customToolCall('wework-cloud-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cloud_initial') {
      this.recordScenarioRequest('cloud_initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real cloud Codex request did not report its tool output to the model service'
      )
      this.cloudModelStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(CLOUD_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cloud_follow_up') {
      this.recordScenarioRequest('cloud_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_FOLLOW_UP_PROMPT),
        'The real cloud Codex request did not contain the follow-up prompt'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(CLOUD_FOLLOW_UP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'follow_up') {
      this.recordScenarioRequest('follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the follow-up prompt'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FOLLOW_UP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'window_lifecycle') {
      this.recordScenarioRequest('window_lifecycle', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(WINDOW_LIFECYCLE_PROMPT),
        'The real Codex request did not contain the window-lifecycle prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      this.resolveWindowLifecycleResponseStarted()
      await this.windowLifecycleRelease
      response.end(
        createSse([
          assistantMessage(WINDOW_LIFECYCLE_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
      )
      return
    }

    if (this.scenario === 'request_user_input') {
      this.recordScenarioRequest('request_user_input', modelRequest)
      if (JSON.stringify(body.input).includes('wework-e2e-request-user-input')) {
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(REQUEST_USER_INPUT_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      assert.ok(
        JSON.stringify(body).includes(REQUEST_USER_INPUT_PROMPT),
        'The real Codex request did not contain the request-user-input prompt'
      )
      const tool = selectTool(body, 'request_user_input', {
        questions: [
          {
            header: 'Direction',
            id: 'direction',
            question: REQUEST_USER_INPUT_QUESTION,
            options: [
              { label: 'Minimal', description: 'Make the smallest focused change.' },
              { label: 'Complete', description: 'Cover the full interaction flow.' },
            ],
          },
        ],
      })
      await this.requestUserInputRelease
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-e2e-request-user-input', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      this.resolveRequestUserInputResponseWritten()
      return
    }

    if (this.scenario === 'fresh_chat') {
      this.recordScenarioRequest('fresh_chat', modelRequest)
      assert.ok(JSON.stringify(body).includes(FRESH_CHAT_PROMPT), 'The fresh chat prompt was lost')
      assert.equal(
        JSON.stringify(body).includes(TASK_PROMPT),
        false,
        'The new conversation inherited the previous task context'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FRESH_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'attachment_only') {
      this.recordScenarioRequest('attachment_only', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(ATTACHMENT_ONLY_FILENAME),
        'The attachment-only request did not contain the selected file'
      )
      const requestNumber = this.scenarioRequests.get('attachment_only').length
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`${ATTACHMENT_ONLY_COMPLETION_TEXT}_${requestNumber}`),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'side_chat_attachment') {
      this.recordScenarioRequest('side_chat_attachment', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat request lost its prompt')
      assert.ok(
        requestText.includes(SIDE_CHAT_FILENAME),
        'The side-chat request lost its isolated attachment'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(SIDE_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cancellation') {
      this.recordScenarioRequest('cancellation', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CANCELLATION_PROMPT),
        'The real Codex request did not contain the cancellation prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      return
    }

    if (this.scenario === 'retry') {
      this.recordScenarioRequest('retry', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RETRY_PROMPT),
        'The real Codex request did not contain the retry prompt'
      )
      const retryRequests = this.scenarioRequests.get('retry') ?? []
      if (retryRequests.length === 1) {
        this.writeSse(response, [
          responseCreated(responseId),
          responseFailed(responseId, 'WEWORK_DESKTOP_E2E_RETRY_FAILURE'),
        ])
        return
      }
      await this.retryCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RETRY_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'reconnect') {
      this.recordScenarioRequest('reconnect', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RECONNECT_PROMPT),
        'The real Codex request did not contain the reconnect prompt'
      )
      const reconnectRequests = this.scenarioRequests.get('reconnect') ?? []
      if (reconnectRequests.length === 1) {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        this.resolveReconnectResponseStarted()
        await this.reconnectDisconnectRelease
        response.destroy()
        return
      }
      await this.reconnectCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RECONNECT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    throw new Error(`Unexpected desktop E2E scenario: ${this.scenario}`)
  }

  handleLocalProtocolResponse(response, model, body, headers) {
    const state = this.localProtocolStates.get(model.protocol)
    assert.ok(state, `Missing local protocol state for ${model.protocol}`)
    state.requests.push({ body, headers })
    const serialized = JSON.stringify(body)
    const initialPrompt = localProtocolPrompt(model, 'INITIAL')
    const followUpPrompt = localProtocolPrompt(model, 'FOLLOW_UP')

    this.assertLocalRequestEnvelope(model, body, headers)

    if (state.stage === 'initial' && serialized.includes(initialPrompt)) {
      this.assertLocalConversation(model, body, {
        includes: [initialPrompt],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      state.stage = 'awaiting_tool_output'
      this.writeLocalToolCall(response, model, localProtocolPatch(model))
      return
    }
    if (state.stage === 'awaiting_tool_output') {
      this.assertLocalConversation(model, body, {
        includes: [],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      this.assertLocalToolOutput(model, body)
      state.stage = 'complete'
      this.writeLocalAssistantMessage(
        response,
        model,
        `WEWORK_LOCAL_${model.protocol.toUpperCase()}_COMPLETE`
      )
      return
    }
    if (state.stage === 'complete' && serialized.includes(followUpPrompt)) {
      const completedMessage = `WEWORK_LOCAL_${model.protocol.toUpperCase()}_COMPLETE`
      this.assertLocalConversation(model, body, {
        includes:
          model.protocol === 'responses'
            ? [initialPrompt, followUpPrompt, completedMessage]
            : [initialPrompt, followUpPrompt, completedMessage],
        excludes: [],
      })
      this.assertLocalApplyPatchTool(model, body)
      // Stateful Responses requests may compact completed tool call/output pairs.
      // Stateless Chat and Anthropic conversions must keep the pair for history.
      if (model.protocol !== 'responses') this.assertLocalToolOutput(model, body)
      state.stage = 'follow_up_complete'
      this.writeLocalAssistantMessage(
        response,
        model,
        `WEWORK_LOCAL_${model.protocol.toUpperCase()}_FOLLOW_UP_COMPLETE`
      )
      return
    }
    // Codex may prewarm a provider before it sends the first prompt and tools.
    if (state.stage === 'initial') {
      assert.equal(
        serialized.includes(initialPrompt),
        false,
        `${model.protocol} prewarm unexpectedly contained the initial prompt`
      )
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    throw new Error(
      `Unexpected ${model.protocol} request at ${state.stage}: ${serialized.slice(0, 1000)}`
    )
  }

  assertLocalRequestEnvelope(model, body, headers) {
    assert.equal(body.model, model.modelId, `${model.protocol} forwarded the wrong model ID`)
    assert.equal(body.stream, true, `${model.protocol} request was not streaming`)
    assert.equal(
      headers.authorization,
      `Bearer ${MODEL_API_KEY}`,
      `${model.protocol} did not forward bearer authentication`
    )
    if (model.protocol === 'responses') {
      assert.ok(Array.isArray(body.input), 'Responses input was not an array')
      assert.equal(
        headers['anthropic-version'],
        undefined,
        'Responses unexpectedly received Anthropic headers'
      )
      return
    }
    assert.ok(Array.isArray(body.messages), `${model.protocol} messages were not an array`)
    if (model.protocol === 'chat') {
      assert.equal(
        body.stream_options?.include_usage,
        true,
        'Chat streaming usage metadata was not requested'
      )
      assert.equal(
        headers['anthropic-version'],
        undefined,
        'Chat unexpectedly received Anthropic headers'
      )
      return
    }
    assert.equal(headers['x-api-key'], MODEL_API_KEY, 'Anthropic x-api-key was not forwarded')
    assert.equal(
      headers['anthropic-version'],
      '2023-06-01',
      'Anthropic protocol version was not forwarded'
    )
    assert.ok(
      typeof body.system === 'string' && body.system.length > 0,
      'Anthropic system instructions were not preserved'
    )
    assert.ok(body.max_tokens > 0, 'Anthropic max_tokens was not populated')
  }

  assertLocalConversation(model, body, { includes, excludes }) {
    const serialized = JSON.stringify(body)
    for (const value of includes) {
      assert.ok(serialized.includes(value), `${model.protocol} request lost history: ${value}`)
    }
    for (const value of excludes) {
      assert.equal(
        serialized.includes(value),
        false,
        `${model.protocol} request leaked future history: ${value}`
      )
    }
  }

  assertLocalApplyPatchTool(model, body) {
    const tools = Array.isArray(body.tools) ? body.tools : []
    const tool = tools.find(
      candidate => (candidate?.name ?? candidate?.function?.name) === 'apply_patch'
    )
    assert.ok(tool, `${model.protocol} did not receive apply_patch`)
    const names = tools
      .map(candidate => candidate?.name ?? candidate?.function?.name)
      .filter(Boolean)
    assert.ok(
      names.includes('shell_command') || names.includes('exec_command'),
      `${model.protocol} did not receive a shell tool: ${names.join(', ')}`
    )
    if (model.protocol === 'responses') {
      assert.equal(tool.type, 'custom', 'Responses apply_patch was not a custom tool')
      assert.equal(tool.format?.type, 'grammar', 'Responses apply_patch grammar was missing')
      assert.equal(tool.format?.syntax, 'lark', 'Responses apply_patch grammar was not Lark')
      assert.ok(tool.format?.definition, 'Responses apply_patch grammar definition was empty')
      return
    }
    if (model.protocol === 'chat') {
      assert.equal(tool.type, 'function', 'Chat apply_patch was not converted to function')
      const description = tool.function?.description ?? ''
      assert.match(
        description,
        /Original tool definition:[\s\S]*"syntax":"lark"/,
        'Chat apply_patch lost its custom grammar'
      )
      this.assertApplyPatchOutputContract(model, description)
      assert.deepEqual(
        tool.function?.parameters,
        {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
        'Chat apply_patch wrapper schema was not preserved'
      )
      return
    }
    assert.ok(tool.input_schema, 'Anthropic apply_patch input_schema was missing')
    const description = tool.description ?? ''
    assert.match(
      description,
      /Original tool definition:[\s\S]*"syntax":"lark"/,
      'Anthropic apply_patch lost its custom grammar'
    )
    this.assertApplyPatchOutputContract(model, description)
    assert.deepEqual(
      tool.input_schema,
      {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: CUSTOM_TOOL_INPUT_DESCRIPTION,
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
      'Anthropic apply_patch wrapper schema was not preserved'
    )
  }

  assertApplyPatchOutputContract(model, description) {
    for (const instruction of [
      'Critical apply_patch input contract:',
      'exactly `*** Begin Patch\\n`',
      'with no blank line',
      'Do not include Markdown code fences',
      'every added-file content line must start with `+`',
    ]) {
      assert.ok(
        description.includes(instruction),
        `${model.protocol} apply_patch wrapper omitted instruction: ${instruction}`
      )
    }
  }

  assertLocalToolOutput(model, body) {
    const patch = localProtocolPatch(model)
    if (model.protocol === 'responses') {
      const output = body.input?.find(item => item?.type === 'custom_tool_call_output')
      assert.equal(
        output?.call_id,
        'local-responses-tool',
        'Responses lost the apply_patch call ID'
      )
      assert.ok(output?.output, 'Responses lost the apply_patch output')
      return
    }
    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'apply_patch')
      assert.deepEqual(
        JSON.parse(call?.function?.arguments ?? '{}'),
        { input: patch },
        'Chat changed the wrapped apply_patch input'
      )
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        'Chat lost the function tool result or call ID'
      )
      return
    }
    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(block => block?.type === 'tool_use' && block?.name === 'apply_patch')
    assert.deepEqual(call?.input, { input: patch }, 'Anthropic changed the apply_patch input')
    assert.ok(
      blocks.some(block => block?.type === 'tool_result' && block?.tool_use_id === call?.id),
      'Anthropic lost the tool_result block or tool_use_id'
    )
  }

  writeLocalToolCall(response, model, patch) {
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-tool`
      this.writeSse(response, [
        responseCreated(id),
        customToolCall(id, 'apply_patch', patch),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, patch)
      return
    }
    this.writeAnthropicToolCall(response, patch)
  }

  writeLocalAssistantMessage(response, model, text) {
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-message`
      const events = [responseCreated(id)]
      if (text) events.push(assistantMessage(text))
      events.push(responseCompleted(id))
      this.writeSse(response, events)
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatMessage(response, text)
      return
    }
    this.writeAnthropicMessage(response, text)
  }

  writeChatToolCall(response, patch) {
    const argumentsValue = JSON.stringify({ input: patch })
    const splitAt = Math.max(1, Math.floor(argumentsValue.length / 2))
    const chunks = [
      {
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'chat-local-apply-patch',
                  type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: argumentsValue.slice(0, splitAt),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'chat-local-apply-patch',
                  function: {
                    name: 'apply_patch',
                    arguments: argumentsValue.slice(splitAt),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]
    this.writeRawSse(
      response,
      `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
    )
  }

  writeChatMessage(response, text) {
    const chunk = {
      id: 'chat-local-message',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }
    this.writeRawSse(response, `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
  }

  writeAnthropicToolCall(response, patch) {
    const input = JSON.stringify({ input: patch })
    this.writeAnthropicSse(response, [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'anthropic-local-tool',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'desktop-e2e-anthropic-model',
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'anthropic-local-apply-patch',
            name: 'apply_patch',
            input: {},
          },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: input },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
  }

  writeAnthropicMessage(response, text) {
    this.writeAnthropicSse(response, [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'anthropic-local-message',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'desktop-e2e-anthropic-model',
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
  }

  writeAnthropicSse(response, events) {
    this.writeRawSse(
      response,
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    )
  }

  writeRawSse(response, body) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(body)
  }

  writeSse(response, events) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(createSse(events))
  }

  async writeStreamingMarkdown(response, responseId, text) {
    const stream = streamingTextEvents(responseId, text)
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.write(createSse(stream.start))
    let offset = 0
    for (const delta of stream.chunks) {
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta,
            offset,
          },
        ])
      )
      offset += [...delta].length
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
    }
    response.end(createSse(stream.finish))
  }
}

async function writeCodexConfig(codexHome, modelServerUrl) {
  await mkdir(codexHome, { recursive: true })
  await writeFile(
    join(codexHome, 'config.toml'),
    `model_provider = "${MODEL_PROVIDER_ID}"\nmodel = "${DEFAULT_MODEL_ID}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[model_providers.${MODEL_PROVIDER_ID}]\nname = "Wework Desktop E2E"\nbase_url = "${modelServerUrl}/v1"\nenv_key = "WEWORK_E2E_MODEL_API_KEY"\nwire_api = "responses"\n`,
    'utf8'
  )
}

async function buildExecutor() {
  const configured = process.env.WEWORK_E2E_EXECUTOR_BIN
  if (configured)
    return resolveExecutable(configured, 'wegent-executor', 'Configured Wework executor')

  await runChecked('cargo', ['build', '--locked', '--bin', 'wegent-executor'], {
    cwd: join(repoDir, 'executor'),
  })
  const binaryName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  const binaryPath = join(repoDir, 'executor', 'target', 'debug', binaryName)
  assert.equal(await isExecutable(binaryPath), true, `Executor build did not produce ${binaryPath}`)
  return binaryPath
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

async function wrapMacDesktopApp(binaryPath, binaryName, appIdentifier) {
  if (process.platform !== 'darwin') return { binaryPath, appBundlePath: null }

  const appBundlePath = join(resultDir, `WeWork-E2E-${process.pid}.app`)
  const contentsPath = join(appBundlePath, 'Contents')
  const bundledBinaryPath = join(contentsPath, 'MacOS', binaryName)
  await mkdir(join(contentsPath, 'MacOS'), { recursive: true })
  await symlink(binaryPath, bundledBinaryPath)
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
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
    'utf8'
  )
  commandOutput(MACOS_LAUNCH_SERVICES_REGISTER, ['-f', appBundlePath])
  return { binaryPath: bundledBinaryPath, appBundlePath }
}

async function buildDesktopApp(controlUrl, cloudBackendUrl, cloudToken, appIdentifier) {
  const configured = process.env.WEWORK_E2E_APP_BIN
  if (configured) {
    const binaryPath = await resolveExecutable(configured, 'app', 'Configured Wework desktop app')
    return wrapMacDesktopApp(binaryPath, binaryPath.split('/').at(-1), appIdentifier)
  }

  const windows = await readTauriE2EWindowConfig()
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
              {
                identifier: 'desktop-e2e-focus',
                description: 'Allows the desktop E2E runner to keep WebKit timers unthrottled',
                windows: ['main'],
                permissions: [
                  'core:window:allow-set-focus',
                  'core:window:allow-show',
                  'core:window:allow-unminimize',
                ],
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
        VITE_WEWORK_E2E: 'true',
        VITE_WEWORK_E2E_SEED_LOCAL_MODELS:
          PLUGINS_ONLY || MEMORY_ONLY || CLOUD_ONLY ? 'false' : 'true',
        VITE_WEWORK_RUNTIME_MODE: 'local-first',
      },
    }
  )
  const mainBinaryName = await readTauriMainBinaryName()
  const binaryName = process.platform === 'win32' ? `${mainBinaryName}.exe` : mainBinaryName
  const candidates = [
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
      return wrapMacDesktopApp(candidate, binaryName, appIdentifier)
    }
  }
  throw new Error(
    `Tauri build did not produce an executable app. Checked: ${candidates.join(', ')}`
  )
}

async function verifyCloudProjectFlow(control, cloudEnvironment, workspacePath) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: UI_TIMEOUT_MS,
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
    timeoutMs: UI_TIMEOUT_MS,
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
    timeoutMs: UI_TIMEOUT_MS,
  })
  const projectSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const deviceStatusTestId = projectSnapshot.testIds.find(testId =>
    testId.startsWith('project-device-status-')
  )
  assert.ok(deviceStatusTestId, 'The cloud project did not expose its remote device status')
  const projectId = deviceStatusTestId.slice('project-device-status-'.length)
  await captureVerificationScreenshot(control, 'cloud-03-project-created.png')
  await control.command(
    'clickWhenEnabled',
    `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-04-conversation-ready.png')
  await openBottomWorkspaceLauncher(control, 'The new cloud task')
  await control.command('click', '[data-testid="workspace-terminal-card"]')
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    'The new cloud task did not start its terminal after Terminal was selected',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(control, 'cloud-04b-new-task-terminal-open.png')
  await control.command('click', '[data-testid="close-bottom-workspace-tab-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The new cloud task terminal and bottom panel did not close cleanly',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.setScenario('cloud_initial')
  await sendPrompt(control, composerSelector, CLOUD_TASK_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('cloud_initial', 2),
    UI_TIMEOUT_MS,
    'The real cloud executor did not complete its model tool loop'
  )
  assert.equal(
    (await readFile(join(workspacePath, CLOUD_ARTIFACT_NAME), 'utf8')).trim(),
    CLOUD_ARTIFACT_CONTENT,
    'The real cloud executor did not create the verification artifact'
  )
  const taskSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
    'The completed cloud task was not persisted in the sidebar'
  )
  const taskRowTestId = taskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-row-')
  )
  assert.ok(taskRowTestId, 'The completed cloud task row was not available')
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-05-initial-task-completed.png')

  await openBottomWorkspaceLauncher(control, 'The historical cloud task')
  await control.command('click', '[data-testid="workspace-terminal-card"]')
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    'The historical cloud task did not start its terminal after Terminal was selected',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await closeBottomWorkspacePanel(control)
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    'The historical cloud task did not restore its existing terminal',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('click', '[data-testid="workspace-terminal-new-tab-button"]')
  const addMenuSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.includes('workspace-terminal-new-tab-menu'),
    'The bottom workspace add menu did not open'
  )
  assert.ok(addMenuSnapshot.testIds.includes('workspace-add-terminal-option'))
  assert.ok(addMenuSnapshot.testIds.includes('workspace-add-ide-option'))
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-desktop-option'),
    false,
    'The external build exposed the internal desktop extension'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await captureVerificationScreenshot(control, 'cloud-05b-historical-terminal-restored.png')
  await closeBottomWorkspacePanel(control)

  control.setScenario('cloud_follow_up')
  await sendPrompt(control, composerSelector, CLOUD_FOLLOW_UP_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('cloud_follow_up'),
    UI_TIMEOUT_MS,
    'The real cloud executor did not send the follow-up model request'
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-06-follow-up-completed.png')

  const projectMenuTestId = `project-menu-${projectId}`
  await waitForSnapshot(
    control,
    value => value.testIds.includes(projectMenuTestId),
    'The cloud project was not shown in the sidebar'
  )
  await control.command('click', `[data-testid="${projectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${projectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${projectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes(projectMenuTestId) &&
      !value.testIds.includes(`remove-project-dialog-${projectId}`),
    'The removed cloud project remained visible in the workbench'
  )
  await captureVerificationScreenshot(control, 'cloud-07-project-removed.png')
}

async function main() {
  await mkdir(resultDir, { recursive: true })
  const workspacePath = join(resultDir, 'workspace')
  const homePath = join(resultDir, 'home')
  const executorHome = join(resultDir, 'executor-home')
  const pluginMarketplacePath = join(resultDir, 'plugin-marketplace')
  const appLogPath = join(resultDir, 'app.log')
  const executorLogPath = join(resultDir, 'executor.log')
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(homePath, { recursive: true }),
  ])
  await writeFile(join(workspacePath, GIT_SEED_NAME), GIT_SEED_CONTENT)
  await writeFile(join(workspacePath, 'auth.ts'), 'export const authenticated = true\n')
  await writeFile(
    join(workspacePath, IMAGE_ARTIFACT_NAME),
    Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
  )
  await createPluginMarketplaceFixture(pluginMarketplacePath)
  await runChecked('git', ['init'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.name', 'Wework Desktop E2E'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.email', 'desktop-e2e@wework.local'], {
    cwd: workspacePath,
  })
  await runChecked('git', ['add', GIT_SEED_NAME, 'auth.ts', IMAGE_ARTIFACT_NAME], {
    cwd: workspacePath,
  })
  await runChecked('git', ['commit', '-m', 'test: initialize desktop e2e workspace'], {
    cwd: workspacePath,
  })

  const desktopScenario = await loadDesktopScenario(
    process.env.WEWORK_E2E_DESKTOP_SCENARIO_MODULE,
    { uiTimeoutMs: UI_TIMEOUT_MS }
  )
  if (DESKTOP_SCENARIO_ONLY && !desktopScenario) {
    throw new Error('Desktop scenario-only mode requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE')
  }
  const control = new DesktopE2EServer(workspacePath, workspacePath, desktopScenario)
  let app
  let appBundlePath
  let cloudEnvironment
  let phase = 'startup'
  try {
    await control.start()
    const codexBinary = await resolveExecutable(
      process.env.CODEX_BIN ?? process.env.CODEX_BINARY_PATH,
      'codex',
      'Codex binary'
    )
    const codexVersion = commandOutput(codexBinary, ['--version'])
    assert.ok(codexVersion.length > 0, 'Real Codex did not return a version')
    console.log(`Using real Codex: ${codexVersion}`)

    const appIdentifier = `io.wecode.wework.e2e.run${process.pid}`
    const executorBinary = await buildExecutor()
    if (CLOUD_ONLY) {
      cloudEnvironment = new RealCloudEnvironment({
        codexBinary,
        executorBinary,
        modelServerUrl: control.url,
        workspacePath,
      })
      await cloudEnvironment.start()
    }
    const desktopApp = await buildDesktopApp(
      control.controlUrl,
      cloudEnvironment?.backendUrl ?? control.url,
      cloudEnvironment?.authToken ?? desktopScenario?.authToken ?? 'wework-desktop-e2e-cloud-token',
      appIdentifier
    )
    const appBinary = desktopApp.binaryPath
    appBundlePath = desktopApp.appBundlePath
    await writeCodexConfig(join(executorHome, 'codex'), control.url)

    app = spawn(appBinary, [], {
      cwd: weworkDir,
      env: {
        ...process.env,
        CODEX_BIN: codexBinary,
        HOME: homePath,
        WEGENT_CODEX_HOME: join(executorHome, 'codex'),
        WEGENT_EXECUTOR_HOME: executorHome,
        WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'true',
        WEGENT_EXECUTOR_LOG_DIR: resultDir,
        WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
        DEVICE_ID: `wework-e2e-device-${process.pid}`,
        DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
        DEVICE_SESSION_GATEWAY_PORT: '0',
        VITE_WEWORK_E2E: 'true',
        WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
        WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR: '127.0.0.1:0',
        WEWORK_EXECUTOR_SIDECAR: executorBinary,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    await Promise.all([
      appendProcessOutput(app.stdout, appLogPath),
      appendProcessOutput(app.stderr, appLogPath),
    ])

    const ready = await withTimeout(
      control.awaitReady(),
      DESKTOP_READY_TIMEOUT_MS,
      'Timed out waiting for the real Tauri application to connect to the Desktop E2E controller'
    )
    assert.match(
      String(ready.location ?? ''),
      /^(tauri|http):/,
      'The desktop controller did not connect from a webview'
    )
    await control.command('focusMainWindow', 'body')

    if (CLOUD_ONLY) {
      phase = 'cloud-project-flow'
      await verifyCloudProjectFlow(control, cloudEnvironment, workspacePath)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop cloud-project E2E passed. Diagnostics: ${resultDir}`)
      return
    }

    phase = 'cloud-request-non-blocking'
    await withTimeout(
      control.awaitBlockedCloudRequest(BLOCKED_CLOUD_MODEL_PATH),
      WORKBENCH_READY_TIMEOUT_MS,
      'The connected desktop app did not start the intentionally blocked cloud model request'
    )
    await control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    control.failBlockedCloudModels()
    await triggerModelReloadUntilCloudFailure(control)

    if (PLUGINS_ONLY) {
      phase = 'plugin-lifecycle'
      await verifyPluginLifecycle(control, pluginMarketplacePath)
      console.log(`Wework desktop plugin E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (desktopScenario) {
      phase = 'desktop-extension-scenario'
      await desktopScenario.verify(control)
      if (DESKTOP_SCENARIO_ONLY) {
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework desktop extension scenario E2E passed. Evidence: ${resultDir}`)
        return
      }
    }

    phase = 'remote-project-dialog'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-remote-option"]')
    await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const remoteProjectDialogText = await control.command(
      'getText',
      '[data-testid="standalone-folder-project-dialog"]'
    )
    assert.match(
      remoteProjectDialogText,
      /New remote project|新建远程项目/,
      'The remote project dialog title was not localized'
    )
    await control.command('click', '[data-testid="standalone-folder-project-dialog-overlay"]')
    const closedRemoteDialogSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      closedRemoteDialogSnapshot.testIds.includes('standalone-folder-project-dialog'),
      false,
      'Clicking the remote project dialog backdrop did not restore the workbench'
    )

    phase = 'project-folder-cancel'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-existing-option"]')
    await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="cancel-device-folder-picker-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="cancel-device-folder-picker-button"]')
    const cancelledFolderPickerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      cancelledFolderPickerSnapshot.testIds.includes('standalone-folder-project-dialog'),
      false,
      'Cancelling folder selection did not restore the workbench'
    )

    phase = 'composer-project-folder-select'
    await control.command('click', '[data-testid="project-work-button"]')
    await control.command('hover', '[data-testid="add-local-project-option"]')
    await control.command('click', '[data-testid="add-local-existing-project-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await waitForFolderPickerInitialized(control)
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="device-folder-path-input"]'),
      workspacePath,
      'The device folder path did not update before confirmation'
    )
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, workspacePath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )

    const composerSelector = ACTIVE_COMPOSER_SELECTOR
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })

    phase = 'composer-project-visible-in-sidebar'
    const openedProjectSnapshot = await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
      'The newly opened folder project was not shown in the sidebar'
    )
    const projectMenuTestId = openedProjectSnapshot.testIds.find(testId =>
      testId.startsWith('project-menu-')
    )
    assert.ok(projectMenuTestId, 'The newly opened folder project was not shown in the sidebar')
    const projectId = projectMenuTestId.slice('project-menu-'.length)
    const projectRowSelector = `[data-testid="project-row-${projectId}"]`
    await control.command('waitFor', projectRowSelector, {
      text: 'workspace',
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: UI_TIMEOUT_MS,
    })

    phase = 'sidebar-project-new-conversation'
    await control.command(
      'click',
      `${projectRowSelector} [data-testid="project-new-conversation-button"]`
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: UI_TIMEOUT_MS,
    })

    phase = 'project-folder-remove-immediately'
    await control.command('click', `[data-testid="${projectMenuTestId}"]`)
    await control.command('click', `[data-testid="remove-project-${projectId}"]`)
    await control.command(
      'click',
      `[data-testid="remove-project-dialog-${projectId}-confirm-button"]`
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes(projectMenuTestId),
      'A folder project could not be removed immediately after it was opened'
    )

    phase = 'project-folder-reopen'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-existing-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await waitForFolderPickerInitialized(control)
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="device-folder-path-input"]'),
      workspacePath,
      'The device folder path did not update before confirmation'
    )
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, workspacePath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid^="project-menu-"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })

    if (ATTACHMENT_ONLY_SIDEBAR) {
      phase = 'attachment-only-sidebar'
      await verifyAttachmentOnlySidebarLifecycle({ appIdentifier, composerSelector, control })
      console.log(`Wework attachment-only sidebar E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (MEMORY_ONLY) {
      phase = 'memory-growth'
      await selectE2EModel(control)
      await verifyMemoryGrowth({ composerSelector, control })
      console.log(`Wework desktop memory E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (SIDE_CHAT_ATTACHMENT_ONLY) {
      phase = 'side-chat-attachment-isolation'
      await verifySideChatAttachmentIsolation({ control })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework side-chat attachment E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (LIFECYCLE_ONLY) {
      await verifyBackgroundTaskWindowLifecycle({
        app,
        appIdentifier,
        composerSelector,
        control,
        executorLogPath,
        setPhase: value => {
          phase = value
        },
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop lifecycle E2E passed. Diagnostics: ${resultDir}`)
      return
    }

    const activeModelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
    const initialModelLabel = await control.command('waitFor', activeModelSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    if (RECONNECT_ONLY) {
      phase = 'reconnect'
      await verifyReconnectRecovery({ composerSelector, control })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop reconnect E2E passed. Evidence: ${resultDir}`)
      return
    }
    phase = 'initial-task'
    await sendPrompt(control, composerSelector, TASK_PROMPT)
    await withTimeout(
      control.awaitScenarioRequest('initial'),
      UI_TIMEOUT_MS,
      'The model service did not receive the initial task request'
    )

    if (VIEW_IMAGE_ONLY) {
      control.releaseInitialToolExecution()
    } else {
      phase = 'send-mode-menu'
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: UI_TIMEOUT_MS,
      })
      await control.command('fill', composerSelector, { value: SEND_MODE_DRAFT })
      await control.command('waitFor', '[data-testid="send-mode-menu-button"]', {
        timeoutMs: UI_TIMEOUT_MS,
      })
      await captureVerificationScreenshot(control, '01-send-mode-follow-up-ready.png')
      await control.command('click', '[data-testid="send-mode-menu-button"]')
      await control.command('waitFor', '[data-testid="send-mode-menu-button-menu"]', {
        timeoutMs: UI_TIMEOUT_MS,
      })
      const sendModeMenuText = await control.command(
        'getText',
        '[data-testid="send-mode-menu-button-menu"]'
      )
      assert.match(
        sendModeMenuText,
        /当前回复结束后发送|Send after current response/,
        'The send-after-turn option was not visible in the send mode menu'
      )
      assert.match(
        sendModeMenuText,
        /引导当前回复|Guide current response/,
        'The guide-current-turn option was not visible in the send mode menu'
      )
      assert.match(
        sendModeMenuText,
        /打断并立即发送|Interrupt and send now/,
        'The interrupt-and-send option was not visible in the send mode menu'
      )
      await captureVerificationScreenshot(control, '02-send-mode-menu-open.png')
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('fill', composerSelector, { value: '' })
    }

    phase = 'initial-task-completion'
    await control.command('waitFor', '[data-testid="environment-info-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const environmentSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (!environmentSnapshot.testIds.includes('environment-changes-button')) {
      await control.command('click', '[data-testid="environment-info-button"]')
    }
    await control.command('waitFor', '[data-testid="environment-changes-button"]', {
      text: '+0',
      timeoutMs: UI_TIMEOUT_MS,
    })
    const cleanEnvironmentText = await control.command(
      'getText',
      '[data-testid="environment-changes-button"]'
    )
    assert.match(cleanEnvironmentText, /\+0\s*-0/, 'The clean workspace diff was not displayed')

    control.releaseInitialToolExecution()
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="final-processing-toggle"]')
    await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const processingSummaryText = await control.command(
      'getText',
      '[data-testid="processing-summary-toggle"]'
    )
    assert.match(
      processingSummaryText,
      /调用 2 个工具，编辑 1 个文件|Called 2 tools, edited 1 file/,
      'The processing summary did not report tool calls and edited files separately'
    )
    await control.command('waitFor', '[aria-label="编辑 1"], [aria-label="Edits 1"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    if (process.platform === 'darwin') {
      await control.command('scrollIntoView', '[data-testid="processing-summary-header"]')
      await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
        visible: true,
        stableMs: 500,
        timeoutMs: UI_TIMEOUT_MS,
      })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      const processingSummaryScreenshot = await control.command(
        'capture',
        '[data-testid="processing-summary-toggle"]'
      )
      await writeFile(
        join(resultDir, 'processing-summary.png'),
        Buffer.from(processingSummaryScreenshot.replace(/^data:image\/png;base64,/, ''), 'base64')
      )
    }
    await control.command('click', '[data-testid="processing-summary-toggle"]')
    await control.command('waitFor', '[data-processing-block-id="wework-e2e-view-image"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
    await control.command(
      'waitFor',
      '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="false"]',
      { visible: true, stableMs: 300, timeoutMs: UI_TIMEOUT_MS }
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    await captureVerificationScreenshot(
      control,
      '03-view-image-collapsed.png',
      '[data-testid="processing-live-preview"]'
    )
    await control.command(
      'click',
      '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle]'
    )
    await control.command('waitFor', '[data-testid="image-view-preview"]', {
      stableMs: 500,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="true"]',
      { stableMs: 500, timeoutMs: UI_TIMEOUT_MS }
    )
    await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
    await control.command('waitFor', '[data-testid="image-view-preview"]', {
      visible: true,
      stableMs: 500,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    await captureVerificationScreenshot(
      control,
      '04-view-image-expanded.png',
      '[data-testid="processing-live-preview"]'
    )
    await control.command('click', '[data-testid="processing-summary-toggle"]')
    await control.command('waitFor', '[data-testid="environment-changes-button"]', {
      text: '+1',
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="file-change-stats-label"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    if (VIEW_IMAGE_ONLY) {
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework view_image desktop E2E passed. Evidence: ${resultDir}`)
      return
    }
    const changedEnvironmentText = await control.command(
      'getText',
      '[data-testid="file-change-stats-label"]'
    )
    assert.match(
      changedEnvironmentText,
      /\+1\s*-0/,
      'The real apply_patch result did not render the expected file diff'
    )

    phase = 'workspace-mention'
    await control.command('fill', composerSelector, { value: '@auth' })
    await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="workspace-mention-option-0"]')
    await control.command('waitFor', '[data-testid="composer-path-chip-auth-ts"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', composerSelector, { value: '' })

    assert.equal(
      await readFile(join(workspacePath, ARTIFACT_NAME), 'utf8'),
      `${ARTIFACT_CONTENT}\n`,
      'The real Codex tool execution did not create the expected workspace artifact'
    )
    assert.equal(
      control.modelStage,
      'complete',
      'The model service did not complete the Codex tool loop'
    )
    assert.ok(control.modelRequests.length >= 2, 'The real Codex did not make both model requests')
    assert.ok(
      control.catalogRequests.length >= 1,
      'The Codex model catalog did not pass through the local router'
    )
    assert.ok(
      typeof control.modelRequests[0].body.model === 'string' &&
        control.modelRequests[0].body.model.length > 0,
      'The real Codex request did not select a model'
    )
    assert.ok(
      control.toolOutput,
      'Codex did not report its real tool execution to the model service'
    )

    phase = 'conversation-model-restore'
    const taskSnapshot = await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
      'The completed task was not available for model restoration'
    )
    const taskRowTestId = taskSnapshot.testIds.find(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
    assert.ok(taskRowTestId, 'The completed task row was not found')
    if (!REQUEST_INPUT_ONLY) {
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="model-selector-button"]', {
        text: MODEL_LABEL,
        timeoutMs: UI_TIMEOUT_MS,
      })

      phase = 'follow-up'
      control.setScenario('follow_up')
      const followUpRequest = await sendPromptUntilScenarioRequest(
        control,
        composerSelector,
        FOLLOW_UP_PROMPT,
        'follow_up'
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FOLLOW_UP_COMPLETION_TEXT,
        timeoutMs: UI_TIMEOUT_MS,
      })
      assert.ok(
        JSON.stringify(followUpRequest.body).includes(FOLLOW_UP_PROMPT),
        'The follow-up request did not preserve the user prompt'
      )

      for (const [index, localModel] of LOCAL_MODEL_CASES.entries()) {
        phase = `local-model-${localModel.protocol}-initial`
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', composerSelector, {
          timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
        })
        await selectE2EModel(control, localModel.optionId, localModel.label)
        await sendPrompt(control, composerSelector, localProtocolPrompt(localModel, 'INITIAL'))
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: `WEWORK_LOCAL_${localModel.protocol.toUpperCase()}_COMPLETE`,
          timeoutMs: UI_TIMEOUT_MS,
        })
        assert.equal(
          await readFile(join(workspacePath, localProtocolArtifact(localModel)), 'utf8'),
          `${localProtocolArtifactContent(localModel)}\n`,
          `${localModel.protocol} apply_patch did not create the expected artifact`
        )

        phase = `local-model-${localModel.protocol}-follow-up`
        await sendPrompt(control, composerSelector, localProtocolPrompt(localModel, 'FOLLOW_UP'))
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: `WEWORK_LOCAL_${localModel.protocol.toUpperCase()}_FOLLOW_UP_COMPLETE`,
          timeoutMs: UI_TIMEOUT_MS,
        })
        const localState = control.localProtocolStates.get(localModel.protocol)
        assert.equal(
          localState?.stage,
          'follow_up_complete',
          `${localModel.protocol} did not complete the send/tool/follow-up lifecycle`
        )
        assert.ok(
          localState.requests.length >= 3,
          `${localModel.protocol} did not send the full model request sequence`
        )
        await prepareCompletedTurnScreenshot(control)
        await captureVerificationScreenshot(
          control,
          `${String(index + 3).padStart(2, '0')}-local-model-${localModel.protocol}-follow-up.png`
        )
      }

      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="model-selector-button"]', {
        text: MODEL_LABEL,
        timeoutMs: UI_TIMEOUT_MS,
      })
    }

    phase = 'background-request-user-input'
    control.setScenario('request_user_input')
    await control.command('click', '[data-testid="add-context-button"]')
    await control.command('click', '[data-testid="set-plan-mode-button"]')
    await control.command('waitFor', '[data-testid="plan-mode-pill"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await sendPromptUntilScenarioRequest(
      control,
      composerSelector,
      REQUEST_USER_INPUT_PROMPT,
      'request_user_input'
    )
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', composerSelector)
    await control.command('press', 'body', { key: 'Escape' })
    await captureVerificationScreenshot(control, '01-request-running-in-background.png')
    await withTimeout(
      control.releaseRequestUserInputResponse(),
      UI_TIMEOUT_MS,
      'Timed out waiting for the request-user-input SSE response'
    )
    await control.command('press', 'body', { key: 'Escape' })
    await control.command('click', `[data-testid="${taskRowTestId}"]`)
    await control.command('waitFor', '[data-testid="request-user-input-card"]', {
      text: REQUEST_USER_INPUT_QUESTION,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, '02-background-request-user-input-visible.png')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000))
    await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: REQUEST_USER_INPUT_COMPLETION_TEXT,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, '03-delayed-answer-completed.png')
    await control.command('click', '[data-testid="cancel-plan-mode-button"]')
    if (REQUEST_INPUT_ONLY) return

    await verifyBackgroundTaskWindowLifecycle({
      app,
      appIdentifier,
      composerSelector,
      control,
      executorLogPath,
      setPhase: value => {
        phase = value
      },
    })

    phase = 'cancellation'
    control.setScenario('cancellation')
    await sendPrompt(control, composerSelector, CANCELLATION_PROMPT)
    await withTimeout(
      control.awaitScenarioRequest('cancellation'),
      UI_TIMEOUT_MS,
      'The model service did not receive the cancellation request'
    )
    await control.command('waitFor', '[data-testid="pause-response-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="pause-response-button"]')
    await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const cancellationText = await control.command('getText', 'body')
    assert.equal(
      cancellationText.includes(CANCELLATION_COMPLETION_TEXT),
      false,
      'The cancelled task unexpectedly rendered a completion response'
    )

    phase = 'retry'
    control.setScenario('retry')
    await sendPromptUntilScenarioRequest(control, composerSelector, RETRY_PROMPT, 'retry')
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
      {
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    await control.command(
      'clickWhenEnabled',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-retry"]`,
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    await waitForScenarioRequestCount(control, 'retry', 2)
    control.releaseRetryResponse()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        text: RETRY_COMPLETION_TEXT,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    assert.equal(
      control.scenarioRequests.get('retry')?.length,
      2,
      'Retry did not issue exactly one additional request for the failed user message'
    )

    phase = 'reconnect'
    await verifyReconnectRecovery({ composerSelector, control })

    phase = 'fresh-chat'
    control.setScenario('fresh_chat')
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    const freshChatSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      freshChatSnapshot.text.includes(TASK_PROMPT),
      false,
      'The new conversation retained the previous task'
    )
    await sendPrompt(control, composerSelector, FRESH_CHAT_PROMPT)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: FRESH_CHAT_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })

    phase = 'standalone-new-task-state'
    await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
    const standaloneTaskSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('project-work-button') &&
        (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
      'The task-section new-task action selected a project'
    )
    assert.ok(
      standaloneTaskSnapshot.testIds.includes('project-work-button'),
      'The standalone new task did not render the project selector'
    )

    await control.command('click', '[data-testid="new-chat-button"]')
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('project-work-button') &&
        (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
      'The global new-task action did not preserve the standalone project state'
    )

    phase = 'permanent-worktree-create'
    const sourceProjectId = projectId
    const sourceProjectMenuTestId = `project-menu-${sourceProjectId}`
    await control.command('waitFor', `[data-testid="${sourceProjectMenuTestId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', `[data-testid="${sourceProjectMenuTestId}"]`)
    await control.command('click', `[data-testid="create-permanent-worktree-${sourceProjectId}"]`)
    await control.command('waitFor', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
      value: 'Permanent E2E',
    })
    await control.command(
      'click',
      `[data-testid="confirm-create-permanent-worktree-${sourceProjectId}"]`
    )
    await waitForSnapshot(
      control,
      snapshot => snapshot.text.includes('Permanent E2E'),
      'The permanent worktree was not added to the project list'
    )
    const appRuntimeEntries = await readdir(join(executorHome, 'app-runtime'), {
      withFileTypes: true,
    })
    const appRuntimeDirectory = appRuntimeEntries.find(entry => entry.isDirectory())
    assert.ok(appRuntimeDirectory, 'The isolated app runtime directory was not created')
    const worktreeState = JSON.parse(
      await readFile(
        join(
          executorHome,
          'app-runtime',
          appRuntimeDirectory.name,
          'runtime-work',
          'worktrees.json'
        ),
        'utf8'
      )
    )
    assert.equal(
      Object.values(worktreeState.records ?? {}).some(record => record.permanent === true),
      true,
      'The created worktree was not marked permanent'
    )

    phase = 'composer-project-create-and-new-chat'
    const projectRowsBeforeComposerCreate = new Set(
      (
        await waitForSnapshot(
          control,
          snapshot => snapshot.testIds.includes('project-work-button'),
          'The project selector was not ready for composer project creation'
        )
      ).testIds.filter(testId => testId.startsWith('project-row-'))
    )
    await control.command('click', '[data-testid="project-work-button"]')
    await control.command('click', '[data-testid="add-local-project-option"]')
    await control.command('click', '[data-testid="add-local-blank-project-option"]')
    await control.command('fill', '[data-testid="standalone-blank-project-name-input"]', {
      value: COMPOSER_PROJECT_NAME,
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="save-standalone-blank-project-button"]'
    )
    const createdComposerProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.text.includes(COMPOSER_PROJECT_NAME) &&
        snapshot.testIds.includes('project-work-button'),
      'The composer-created project was not selected after creation'
    )
    const createdComposerProjectRow = createdComposerProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-row-') && !projectRowsBeforeComposerCreate.has(testId)
    )
    assert.ok(
      createdComposerProjectRow,
      'The composer-created project was not added to the sidebar'
    )

    await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('project-work-button') &&
        (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
      'The standalone new task did not clear the composer-created project'
    )
    await control.command(
      'clickWhenEnabled',
      `[data-testid="${createdComposerProjectRow}"] [data-testid="project-new-conversation-button"]`
    )
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: COMPOSER_PROJECT_NAME,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })

    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    console.log(`Wework desktop task-flow E2E passed. Diagnostics: ${resultDir}`)
  } catch (error) {
    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    await writeFile(
      join(resultDir, 'scenario-state.json'),
      `${JSON.stringify(
        {
          phase,
          scenario: control.scenario,
          modelStage: control.modelStage,
          localProtocolStates: Object.fromEntries(
            [...control.localProtocolStates.entries()].map(([protocol, state]) => [
              protocol,
              { stage: state.stage, requestCount: state.requests.length },
            ])
          ),
          desktopScenario: desktopScenario?.diagnostics?.() ?? null,
          cloudModelStage: control.cloudModelStage,
          scenarioRequestCounts: Object.fromEntries(
            [...control.scenarioRequests.entries()].map(([name, requests]) => [
              name,
              requests.length,
            ])
          ),
          commandHistory: control.commandHistory,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    try {
      const snapshot = await control.command('snapshot', 'body', { timeoutMs: 5000 })
      await writeFile(join(resultDir, 'ui-snapshot.json'), `${snapshot}\n`, 'utf8')
    } catch {
      // Preserve the original test failure when the WebView can no longer answer diagnostics.
    }
    await writeFile(
      join(resultDir, 'failure.txt'),
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      'utf8'
    )
    throw error
  } finally {
    await cloudEnvironment?.stop()
    await stopProcessGroup(app)
    await control.close()
    if (appBundlePath) {
      spawnSync(MACOS_LAUNCH_SERVICES_REGISTER, ['-u', appBundlePath])
    }
  }
}

main().then(
  () => process.stdout.write('', () => process.exit(0)),
  error => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`, () => process.exit(1))
  }
)
