import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import {
  readRequestBody,
  selectTool,
  requestAdvertisesShellTool,
} from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { selectWorkbenchTheme } from '../modules/appearance-theme.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PANE = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const PROMPT = 'WEWORK_DESKTOP_E2E_BACKGROUND_TERMINALS'
const COMPLETE = 'WEWORK_BACKGROUND_TERMINALS_STARTED'
const MARKERS = ['WEWORK_BACKGROUND_PROCESS_ONE', 'WEWORK_BACKGROUND_PROCESS_TWO']
const PLUGIN_PROMPT = 'WEWORK_DESKTOP_E2E_PLUGIN_BACKGROUND_TERMINAL'
const PLUGIN_COMPLETE = 'WEWORK_PLUGIN_BACKGROUND_TERMINAL_STARTED'
const PLUGIN_MARKER = 'WEWORK_BACKGROUND_PLUGIN_TERMINAL'
const PLUGIN_NAME = 'background-terminal-plugin'
const PLUGIN_ID = `${PLUGIN_NAME}@wework-personal`
const SECTION = '[data-testid="environment-background-terminals-section"]'
const SUMMARY_BUTTON = '[data-testid="environment-info-button"]'

async function preparePluginFixture(marketplaceRoot) {
  const pluginRoot = join(marketplaceRoot, 'plugins', PLUGIN_NAME)
  await mkdir(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
  await mkdir(join(pluginRoot, 'skills', 'background-terminal'), { recursive: true })
  await writeFile(
    join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'wework-personal',
      plugins: [
        {
          name: PLUGIN_NAME,
          version: '1.0.0',
          source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
        },
      ],
    })
  )
  await writeFile(
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', skills: './skills' })
  )
  await writeFile(
    join(pluginRoot, 'skills', 'background-terminal', 'SKILL.md'),
    '---\nname: background-terminal\ndescription: Exercise plugin changes around live terminals\n---\n'
  )
}

function events(id, items) {
  return [
    { type: 'response.created', response: { id } },
    ...items,
    {
      type: 'response.completed',
      response: { id, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
    },
  ]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

async function showSummary(control) {
  const button = SUMMARY_BUTTON
  await control.command('waitFor', button)
  if ((await control.command('getAttribute', button, { value: 'aria-expanded' })) !== 'true') {
    await control.command('click', button)
  }
  await control.command('waitFor', SECTION)
}

async function verifyCommandLabels(control) {
  for (const marker of MARKERS) {
    const row = `${SECTION} [data-testid^="open-background-terminal-"][title*="${marker}"]`
    const label = await control.command('getText', row)
    assert.ok(label.startsWith('node -e '), `Expected the actual Node command, received: ${label}`)
    assert.ok(label.includes(marker), `The process label must identify ${marker}`)
    assert.ok(!label.includes(' -lc '), 'The process label must omit shell launchers')
    assert.ok(
      (await control.command('getAttribute', row, { value: 'title' })).includes(marker),
      'The full original command must remain available in the tooltip'
    )
  }
}

async function waitForIdle(control, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (!snapshot.pane.status.isBusy) return snapshot
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The AI turn did not finish while its background processes remained running')
}

async function waitForExecutorMethod(logPath, method, offset, timeoutMs) {
  await waitForValue(
    async () => {
      try {
        return (await readFile(logPath, 'utf8')).slice(offset).includes(`method=${method}`)
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
    },
    started => started,
    `The real executor did not start ${method}`,
    timeoutMs
  )
}

async function waitForBackgroundTerminalCount(control, expected, timeoutMs) {
  await waitForValue(
    () =>
      control.command('getElementCount', `${SECTION} [data-testid^="open-background-terminal-"]`),
    count => Number(count) === expected,
    `Background terminal count did not become ${expected}`,
    timeoutMs
  )
}

function terminalTicks(text, marker) {
  const pattern = new RegExp(`${marker}_TICK_(\\d+)`, 'g')
  return [...text.matchAll(pattern)].map(match => Number(match[1]))
}

async function waitForTerminalProgress(control, marker, afterTick, timeoutMs) {
  const tree = '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree'
  return waitForValue(
    () => control.command('getText', tree),
    text => {
      const ticks = terminalTicks(text, marker)
      const latest = Math.max(...ticks)
      return latest > afterTick ? latest : false
    },
    `Terminal output did not advance beyond tick ${afterTick}`,
    timeoutMs
  )
}

async function changeTheme(control, mode) {
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('click', '[data-testid="settings-nav-appearance"]')
  await control.command('click', `[data-testid="appearance-mode-${mode}"]`)
  await control.command('waitFor', `html[data-theme="${mode}"]`)
  await control.command('click', '[data-testid="settings-back-button"]')
}

export async function verifyTerminalHistory(control, timeoutMs) {
  const panel = '[data-testid="background-terminal-output-panel"]'
  const tree = `${panel} .xterm-accessibility-tree`
  const textarea = `${panel} .xterm-helper-textarea`
  await control.command('waitFor', tree, { text: MARKERS[0] })
  const firstRow = `${tree} > [role="listitem"]:first-child[aria-posinset]`
  // A full viewport is required: at the live bottom, new output scrolls it again.
  await control.command('waitFor', `${firstRow}:not([aria-posinset="1"])`, { timeoutMs })
  let position
  let pages = 0
  do {
    const observation = JSON.parse(
      await control.command('nativePress', textarea, {
        key: 'Shift+PageUp',
        target: `${panel} [data-testid="background-terminal-xterm"]`,
      })
    )
    const { nativeTerminalKeys } = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body')
    )
    const before = nativeTerminalKeys.samples.findLast(
      sample => sample.phase === 'native-event' && sample.event?.key === 'PageUp'
    )
    assert.equal(before?.event.isTrusted, true, 'Paging must use a real native key event')
    position = Number(observation.viewportBefore)
    assert.ok(Number.isSafeInteger(position) && position > 0, 'Missing native page-up baseline')
    const next = Number(observation.viewportAfter)
    assert.ok(
      Number.isSafeInteger(next) && next > 0 && (position === 1 ? next === 1 : next < position),
      `Native page-up did not move backwards: ${position} -> ${next}`
    )
    await control.command('waitFor', `${firstRow}[aria-posinset="${next}"]`, { timeoutMs })
    if (position > 1) pages += 1
    position = next
  } while (position > 1)
  await control.command('waitFor', tree, { text: `${MARKERS[0]}_TICK_12` })
  const lines = (await control.command('getText', `${tree} > div`)).split('\n')
  for (let tick = 1; tick <= 12; tick += 1)
    assert.ok(lines.includes(`${MARKERS[0]}_TICK_${tick}`), `Missing terminal output tick ${tick}`)
  for (let page = 0; page <= pages; page += 1) {
    await control.command('nativePress', textarea, { key: 'Shift+PageDown' })
  }
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  workspacePath,
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  const capture = (control, name) => captureScreenshot(control, name, 'body')
  const pluginMarketplaceRoot = join(resultDir, 'background-terminal-plugin')
  const pluginMarketplacePath = join(
    pluginMarketplaceRoot,
    '.agents',
    'plugins',
    'marketplace.json'
  )
  const pluginCacheRoot = join(
    executorHome,
    'codex',
    'plugins',
    'cache',
    'wework-personal',
    PLUGIN_NAME
  )
  const captureTerminalKeys = async (control, name) => {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    await writeFile(join(resultDir, name), JSON.stringify(snapshot.nativeTerminalKeys, null, 2))
  }
  let active = false
  let launched = false
  let pluginLaunched = false
  const toolResults = []
  return {
    appEnvironment: { WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY: resultDir },
    async prepareApp() {
      await preparePluginFixture(pluginMarketplaceRoot)
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      toolResults.push(
        ...(Array.isArray(body.input) ? body.input : []).filter(item =>
          ['function_call_output', 'custom_tool_call_output'].includes(item.type)
        )
      )
      await writeFile(
        join(resultDir, 'background-terminal-tool-results.json'),
        JSON.stringify(toolResults, null, 2)
      )
      const id = `background-terminals-${Date.now()}`
      const items = []
      const pluginPrompt = JSON.stringify(body).includes(PLUGIN_PROMPT)
      if (!launched && JSON.stringify(body).includes(PROMPT)) {
        assert.ok(
          requestAdvertisesShellTool(body),
          'Real Codex must advertise unified exec for background terminals'
        )
        launched = true
        for (const [index, marker] of MARKERS.entries()) {
          const tool = selectTool(body, 'exec_command', {
            cmd: `node -e "console.log('${marker}'); let tick=0; setInterval(()=>console.log('${marker}_TICK_'+ ++tick), 250)"`,
            workdir: workspacePath,
            yield_time_ms: 1000,
            max_output_tokens: 200,
          })
          items.push(...selectedToolCall(`background_${index}`, tool, index))
        }
      } else if (!pluginLaunched && pluginPrompt) {
        pluginLaunched = true
        const tool = selectTool(body, 'exec_command', {
          cmd: `node -e "console.log('${PLUGIN_MARKER}'); let tick=0; setInterval(()=>console.log('${PLUGIN_MARKER}_TICK_'+ ++tick), 250)"`,
          workdir: workspacePath,
          yield_time_ms: 1000,
          max_output_tokens: 200,
        })
        items.push(...selectedToolCall('plugin_background_terminal', tool, 0))
      } else {
        items.push({
          type: 'response.output_item.done',
          item: {
            id: `${id}-message`,
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [
              {
                type: 'output_text',
                text: pluginPrompt ? PLUGIN_COMPLETE : COMPLETE,
                annotations: [],
              },
            ],
          },
        })
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(events(id, items))
      return true
    },

    async verify(control) {
      await selectWorkbenchTheme(control, { timeoutMs: uiTimeoutMs })
      active = true
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1280, height: 800 }),
      })
      await createSingleRootLocalProject(control, workspacePath, 'background-terminals-e2e')
      const composer = `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`
      await control.command('waitFor', composer)
      await selectE2EModel(control)
      await capture(control, 'background-terminals-01-ready.png')
      await control.command('fill', composer, { value: PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
        text: COMPLETE,
        // Windows unified exec clamps each initial yield to at least ten seconds.
        timeoutMs: modelResponseTimeoutMs,
      })
      const snapshot = await waitForIdle(control, uiTimeoutMs)
      await writeFile(
        join(resultDir, 'background-terminal-runtime-snapshot.json'),
        JSON.stringify(snapshot, null, 2)
      )
      await showSummary(control)
      await verifyCommandLabels(control)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${SECTION} [data-testid^="open-background-terminal-"]`
          )
        ),
        2
      )
      assert.equal(
        snapshot.pane.status.isBusy,
        false,
        'A background process must not keep its AI turn busy'
      )
      await capture(control, 'background-terminals-02-process-summary.png')

      await control.command(
        'click',
        `${SECTION} [data-testid^="open-background-terminal-"][title*="${MARKERS[0]}"]`
      )
      await control.command('waitFor', '[data-testid="background-terminal-output-panel"] .xterm')
      await verifyTerminalHistory(control, uiTimeoutMs)
      await captureTerminalKeys(control, 'background-terminal-keys-initial.json')
      await control.command('waitFor', '[data-testid^="right-workspace-background-terminal:"]', {
        text: MARKERS[0],
      })
      const tabLabel = await control.command(
        'getText',
        '[data-testid^="right-workspace-background-terminal:"][role="tab"]'
      )
      assert.ok(tabLabel.startsWith('node -e '), 'The terminal tab must show the actual command')
      assert.ok(!tabLabel.includes(' -lc '), 'The terminal tab must omit shell launchers')
      const textarea = '[data-testid="background-terminal-output-panel"] .xterm-helper-textarea'
      await control.command('waitFor', textarea)
      await capture(control, 'background-terminals-03-live-output.png')
      await changeTheme(control, 'dark')
      await control.command(
        'waitFor',
        '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree',
        { text: MARKERS[0] }
      )
      await capture(control, 'background-terminals-03b-dark-output.png')
      await showSummary(control)
      await capture(control, 'background-terminals-03c-dark-summary.png')
      await changeTheme(control, 'light')

      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await showSummary(control)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${SECTION} [data-testid^="open-background-terminal-"]`
          )
        ),
        2,
        'Reload must restore running terminal processes'
      )
      await verifyCommandLabels(control)
      await capture(control, 'background-terminals-04-restored-summary.png')
      await control.command(
        'click',
        `${SECTION} [data-testid^="open-background-terminal-"][title*="${MARKERS[0]}"]`
      )
      await verifyTerminalHistory(control, uiTimeoutMs)
      await captureTerminalKeys(control, 'background-terminal-keys-restored.json')
      await capture(control, 'background-terminals-04b-restored-output.png')
      await showSummary(control)

      const executorLogPath = join(resultDir, 'executor.log')
      const pluginParams = {
        marketplacePath: pluginMarketplacePath,
        pluginName: PLUGIN_NAME,
      }
      const installLogOffset = (await readFile(executorLogPath, 'utf8')).length
      let installFinished = false
      const installing = requestExecutor(
        control,
        'runtime.codex.plugin.install_local_first',
        pluginParams,
        modelResponseTimeoutMs
      ).finally(() => {
        installFinished = true
      })
      await waitForExecutorMethod(
        executorLogPath,
        'runtime.codex.plugin.install_local_first',
        installLogOffset,
        uiTimeoutMs
      )
      await waitForBackgroundTerminalCount(control, 2, uiTimeoutMs)
      const installTree =
        '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree'
      const installTicks = terminalTicks(await control.command('getText', installTree), MARKERS[0])
      assert.ok(installTicks.length > 0, 'The background terminal must remain readable')
      await waitForTerminalProgress(control, MARKERS[0], Math.max(...installTicks), uiTimeoutMs)
      assert.equal(
        installFinished,
        false,
        'Local plugin installation stopped the shared Codex process while background terminals were active'
      )
      await capture(control, 'background-terminals-05-plugin-install-pending.png')
      await showSummary(control)
      await control.command('hover', `${SECTION} [data-testid^="open-background-terminal-"]`)
      const stopSelector = `${SECTION} [data-testid^="stop-background-terminals-"]`
      const stopTestId = await control.command('getAttribute', stopSelector, {
        value: 'data-testid',
      })
      await control.command(
        'nativePress',
        `${SECTION} [data-testid^="open-background-terminal-"]`,
        {
          key: 'Tab',
        }
      )
      assert.equal(await control.command('getActiveElementTestId', 'body'), stopTestId)
      await capture(control, 'background-terminals-06-stop-action.png')
      await control.command('click', stopSelector)
      await waitForBackgroundTerminalCount(control, 0, uiTimeoutMs)
      const installed = await installing
      assert.equal(installed.localCommitted, true)
      await access(join(pluginCacheRoot, '1.0.0'))
      assert.ok(
        (await readFile(join(executorHome, 'codex', 'config.toml'), 'utf8')).includes(PLUGIN_ID)
      )
      await capture(control, 'background-terminals-07-plugin-installed.png')
      await control.command('click', SUMMARY_BUTTON)
      await control.command(
        'waitFor',
        '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree',
        { text: MARKERS[0] }
      )
      await capture(control, 'background-terminals-08-retained-output.png')

      await control.command('waitFor', composer)
      await control.command('fill', composer, { value: PLUGIN_PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
        text: PLUGIN_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      await waitForIdle(control, uiTimeoutMs)
      await showSummary(control)
      await waitForBackgroundTerminalCount(control, 1, uiTimeoutMs)
      await control.command(
        'click',
        `${SECTION} [data-testid^="open-background-terminal-"][title*="${PLUGIN_MARKER}"]`
      )
      await control.command(
        'waitFor',
        '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree',
        { text: PLUGIN_MARKER, timeoutMs: uiTimeoutMs }
      )
      const pluginTerminalTree =
        '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree'
      const pluginTerminalTicks = terminalTicks(
        await control.command('getText', pluginTerminalTree),
        PLUGIN_MARKER
      )
      assert.ok(pluginTerminalTicks.length > 0, 'The plugin terminal must remain readable')

      const uninstallLogOffset = (await readFile(executorLogPath, 'utf8')).length
      let uninstallFinished = false
      const uninstalling = requestExecutor(
        control,
        'runtime.codex.plugin.uninstall_local',
        { pluginName: PLUGIN_NAME },
        modelResponseTimeoutMs
      ).finally(() => {
        uninstallFinished = true
      })
      await waitForExecutorMethod(
        executorLogPath,
        'runtime.codex.plugin.uninstall_local',
        uninstallLogOffset,
        uiTimeoutMs
      )
      await waitForTerminalProgress(
        control,
        PLUGIN_MARKER,
        Math.max(...pluginTerminalTicks),
        uiTimeoutMs
      )
      assert.equal(
        uninstallFinished,
        false,
        'Local plugin uninstall stopped the shared Codex process while a background terminal was active'
      )
      await capture(control, 'background-terminals-09-plugin-uninstall-pending.png')
      await showSummary(control)
      await control.command(
        'hover',
        `${SECTION} [data-testid^="open-background-terminal-"][title*="${PLUGIN_MARKER}"]`
      )
      await control.command('click', stopSelector)
      await waitForBackgroundTerminalCount(control, 0, uiTimeoutMs)
      const uninstalled = await uninstalling
      assert.equal(uninstalled.localCommitted, true)
      await assert.rejects(access(pluginCacheRoot), { code: 'ENOENT' })
      assert.ok(
        !(await readFile(join(executorHome, 'codex', 'config.toml'), 'utf8')).includes(PLUGIN_ID)
      )
      await capture(control, 'background-terminals-10-plugin-uninstalled.png')
      await control.command('click', SUMMARY_BUTTON)
      await control.command(
        'waitFor',
        '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree',
        { text: PLUGIN_MARKER }
      )
      await capture(control, 'background-terminals-11-plugin-terminal-retained.png')
    },
  }
}
