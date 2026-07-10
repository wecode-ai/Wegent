import { invoke } from '@tauri-apps/api/core'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import {
  isLocalChatStreamDebugEnabled,
  setLocalChatStreamDebugEnabled,
} from '@/api/local/localChatStream'
import {
  clearWorkbenchDebugLogs,
  getWorkbenchDebugSnapshot,
  type WorkbenchDebugSnapshot,
} from './debugPanel'
import {
  isPerformanceDiagnosticsEnabled,
  isPerformanceDiagnosticsShortcut,
  setPerformanceDiagnosticsEnabled,
} from './performanceDiagnostics'
import { isTauriRuntime } from './runtime-environment'
import { setEmbeddedBrowserOcclusion } from './embedded-browser'
import { APP_UPDATE_SIMULATE_EVENT } from '@/features/app-update/app-update-context'

const MENU_ID = 'wework-developer-command-menu'
const DEBUG_PANEL_ID = 'wework-debug-panel'
const DEBUG_PANEL_VISIBILITY_EVENT = 'wework:debug-panel-visibility-change'
const INSPECTOR_COMMAND = 'open_main_webview_devtools'
const OPEN_LOG_DIRECTORY_COMMAND = 'open_app_log_directory'
const CODEX_STREAM_DEBUG_GET_METHOD = 'runtime.codex.stream_debug.get'
const CODEX_STREAM_DEBUG_SET_METHOD = 'runtime.codex.stream_debug.set'
const DEVELOPER_COMMAND_MENU_OCCLUSION_ID = 'developer-command-menu'
const DEBUG_PANEL_OCCLUSION_ID = 'debug-panel'

interface DeveloperCommand {
  id: string
  label: string
  description: string
  run: () => void | Promise<void>
}

interface CodexStreamDebugState {
  enabled: boolean
}

let codexStreamDebugEnabled: boolean | null = null
let codexStreamDebugLoad: Promise<void> | null = null

export function installDeveloperCommandMenu() {
  window.addEventListener(
    'keydown',
    event => {
      if (!isPerformanceDiagnosticsShortcut(event)) return

      event.preventDefault()
      event.stopPropagation()
      openDeveloperCommandMenu()
    },
    { capture: true }
  )
}

function openDeveloperCommandMenu() {
  closeDeveloperCommandMenu()
  setEmbeddedBrowserOcclusion(DEVELOPER_COMMAND_MENU_OCCLUSION_ID, true)

  const overlay = document.createElement('div')
  overlay.id = MENU_ID
  overlay.className =
    'fixed inset-0 z-[2147483647] flex items-start justify-center bg-black/20 px-4 pt-[12vh]'
  overlay.setAttribute('role', 'presentation')

  const dialog = document.createElement('div')
  dialog.className =
    'w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background text-text-primary shadow-2xl'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Developer commands')

  const header = document.createElement('div')
  header.className = 'border-b border-border px-4 py-3'
  header.innerHTML =
    '<div class="text-sm font-semibold">Developer Commands</div><div class="mt-1 text-xs text-text-muted">Cmd+Option+Shift+P</div>'

  const list = document.createElement('div')
  list.className = 'max-h-[60vh] overflow-y-auto p-2'
  renderDeveloperCommandList(list)

  dialog.append(header, list)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeDeveloperCommandMenu()
  })
  overlay.addEventListener('keydown', handleMenuKeyDown)

  void refreshCodexStreamDebugStatus(() => {
    if (document.getElementById(MENU_ID)) renderDeveloperCommandList(list)
  })
}

function closeDeveloperCommandMenu() {
  document.getElementById(MENU_ID)?.remove()
  setEmbeddedBrowserOcclusion(DEVELOPER_COMMAND_MENU_OCCLUSION_ID, false)
}

function handleMenuKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDeveloperCommandMenu()
    return
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

  event.preventDefault()
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`#${MENU_ID} button[data-command-id]`)
  )
  const activeIndex = buttons.findIndex(button => button === document.activeElement)
  const direction = event.key === 'ArrowDown' ? 1 : -1
  const nextIndex = (Math.max(activeIndex, 0) + direction + buttons.length) % buttons.length
  buttons[nextIndex]?.focus()
}

function renderDeveloperCommandList(list: HTMLElement) {
  list.innerHTML = ''
  getDeveloperCommands().forEach((command, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className =
      'flex w-full flex-col rounded-md px-3 py-2 text-left transition-colors hover:bg-muted focus:bg-muted focus:outline-none'
    button.dataset.commandId = command.id
    button.dataset.testid = `developer-command-${command.id}`
    button.innerHTML = `<span class="text-sm font-medium">${escapeHtml(command.label)}</span><span class="mt-0.5 text-xs text-text-muted">${escapeHtml(command.description)}</span>`
    button.addEventListener('click', () => {
      closeDeveloperCommandMenu()
      void command.run()
    })
    list.appendChild(button)

    if (index === 0) {
      window.setTimeout(() => button.focus(), 0)
    }
  })
}

function getDeveloperCommands(): DeveloperCommand[] {
  const diagnosticsEnabled = isPerformanceDiagnosticsEnabled()
  const streamDebugKnown = codexStreamDebugEnabled !== null
  const streamLogsEnabled = isLocalChatStreamDebugEnabled() || (codexStreamDebugEnabled ?? false)
  return [
    {
      id: 'open-debug-panel',
      label: 'Debug Panel',
      description: 'Inspect the active runtime task state and recent console.debug logs.',
      run: () => openDebugPanel(),
    },
    {
      id: 'simulate-app-update',
      label: 'Simulate App Update',
      description: 'Simulate an update download and installation without changing the app.',
      run: () => window.dispatchEvent(new Event(APP_UPDATE_SIMULATE_EVENT)),
    },
    {
      id: 'reload',
      label: 'Reload App',
      description: 'Reload the current WebView.',
      run: () => window.location.reload(),
    },
    {
      id: 'toggle-performance-diagnostics',
      label: diagnosticsEnabled
        ? 'Disable Performance Diagnostics'
        : 'Enable Performance Diagnostics',
      description: 'Toggle JS heap, DOM, event-loop, long-task, and React commit sampling.',
      run: () => {
        setPerformanceDiagnosticsEnabled(!diagnosticsEnabled)
        window.location.reload()
      },
    },
    {
      id: 'toggle-stream-logs',
      label: streamDebugKnown
        ? streamLogsEnabled
          ? 'Disable Stream Logs'
          : 'Enable Stream Logs'
        : 'Toggle Stream Logs',
      description: streamDebugKnown
        ? `Frontend stream logs and Codex executor stream logs are currently ${streamLogsEnabled ? 'enabled' : 'disabled'}.`
        : 'Read and toggle frontend stream logs plus Codex executor stream logs.',
      run: toggleCodexStreamDebug,
    },
    {
      id: 'print-performance-snapshot',
      label: 'Print Performance Snapshot',
      description: 'Print window.__WEWORK_PERF__.snapshot() to the console.',
      run: async () => {
        if (!window.__WEWORK_PERF__) {
          console.warn('[Wework perf] diagnostics are not enabled.')
          return
        }
        await window.__WEWORK_PERF__.processSnapshot()
        console.info('[Wework perf] snapshot', window.__WEWORK_PERF__.snapshot())
      },
    },
    {
      id: 'open-log-directory',
      label: 'Open Log Directory',
      description: 'Open the folder that contains Tauri and frontend logs.',
      run: async () => {
        if (!isTauriRuntime()) {
          console.warn('[Wework dev] Log directory is only available in the Tauri app.')
          return
        }
        await invoke(OPEN_LOG_DIRECTORY_COMMAND).catch(error => {
          console.error('[Wework dev] Failed to open log directory', error)
        })
      },
    },
    {
      id: 'open-web-inspector',
      label: 'Open Web Inspector',
      description: 'Open Tauri Web Inspector for heap and CPU profiling in diagnostic builds.',
      run: async () => {
        if (!isTauriRuntime()) {
          console.warn('[Wework dev] Web Inspector is only available in the Tauri app.')
          return
        }
        await invoke(INSPECTOR_COMMAND).catch(error => {
          console.error('[Wework dev] Failed to open Web Inspector', error)
        })
      },
    },
  ]
}

async function refreshCodexStreamDebugStatus(onLoaded?: () => void) {
  if (!isTauriRuntime()) return
  if (!codexStreamDebugLoad) {
    codexStreamDebugLoad = requestLocalExecutor<CodexStreamDebugState>(
      CODEX_STREAM_DEBUG_GET_METHOD
    )
      .then(state => {
        codexStreamDebugEnabled = state.enabled
      })
      .catch(error => {
        console.warn('[Wework dev] Failed to read Codex stream log state', error)
      })
      .finally(() => {
        codexStreamDebugLoad = null
      })
  }

  await codexStreamDebugLoad
  onLoaded?.()
}

async function toggleCodexStreamDebug() {
  if (!isTauriRuntime()) {
    setLocalChatStreamDebugEnabled(!isLocalChatStreamDebugEnabled())
    console.info(
      `[Wework dev] Frontend stream logs ${isLocalChatStreamDebugEnabled() ? 'enabled' : 'disabled'}.`
    )
    return
  }

  if (codexStreamDebugEnabled === null) {
    await refreshCodexStreamDebugStatus()
  }
  const enabled = !(isLocalChatStreamDebugEnabled() || (codexStreamDebugEnabled ?? false))
  setLocalChatStreamDebugEnabled(enabled)
  try {
    const state = await requestLocalExecutor<CodexStreamDebugState>(CODEX_STREAM_DEBUG_SET_METHOD, {
      enabled,
    })
    codexStreamDebugEnabled = state.enabled
    console.info(`[Wework dev] Stream logs ${state.enabled ? 'enabled' : 'disabled'}.`)
  } catch (error) {
    setLocalChatStreamDebugEnabled(!enabled)
    console.error('[Wework dev] Failed to toggle Codex stream logs', error)
  }
}

function openDebugPanel() {
  closeDebugPanel()

  const root = document.createElement('div')
  root.id = DEBUG_PANEL_ID
  document.body.appendChild(root)
  renderDebugPanelShell(root, true)
}

function closeDebugPanel() {
  document.getElementById(DEBUG_PANEL_ID)?.remove()
  emitDebugPanelVisibility(false)
}

function renderDebugPanelShell(root: HTMLElement, expanded: boolean) {
  emitDebugPanelVisibility(expanded)
  const snapshot = getWorkbenchDebugSnapshot()
  root.innerHTML = ''
  root.className = expanded
    ? 'fixed inset-0 z-[2147483647] flex items-stretch justify-center bg-black/30 p-4'
    : 'fixed bottom-4 right-4 z-[2147483647]'
  root.setAttribute('role', 'presentation')

  if (!expanded) {
    root.onclick = null
    root.onkeydown = null
    root.appendChild(createCollapsedDebugPanel(snapshot, () => renderDebugPanelShell(root, true)))
    return
  }

  const dialog = document.createElement('div')
  dialog.className =
    'flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-background text-text-primary shadow-2xl'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Debug panel')

  const header = document.createElement('div')
  header.className =
    'flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3'

  const title = document.createElement('div')
  title.innerHTML =
    '<div class="text-sm font-semibold">Debug Panel</div><div class="mt-1 text-xs text-text-muted">Active task state and console.debug logs</div>'

  const body = document.createElement('div')
  body.className = 'grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1fr_1fr]'
  renderDebugPanelBody(body, snapshot)

  const actions = document.createElement('div')
  actions.className = 'flex items-center gap-2'
  actions.append(
    createDebugPanelButton('Refresh', () =>
      renderDebugPanelBody(body, getWorkbenchDebugSnapshot())
    ),
    createDebugPanelButton('Copy Snapshot', () => copyDebugSnapshot(getWorkbenchDebugSnapshot())),
    createDebugPanelButton('Clear Logs', () => {
      clearWorkbenchDebugLogs()
      renderDebugPanelBody(body, getWorkbenchDebugSnapshot())
    }),
    createDebugPanelButton('Collapse', () => renderDebugPanelShell(root, false)),
    createDebugPanelButton('Close', closeDebugPanel)
  )

  header.append(title, actions)
  dialog.append(header, body)
  root.appendChild(dialog)

  root.onclick = event => {
    if (event.target === root) renderDebugPanelShell(root, false)
  }
  root.onkeydown = event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    renderDebugPanelShell(root, false)
  }
}

function emitDebugPanelVisibility(expanded: boolean) {
  setEmbeddedBrowserOcclusion(DEBUG_PANEL_OCCLUSION_ID, expanded)
  window.dispatchEvent(
    new CustomEvent(DEBUG_PANEL_VISIBILITY_EVENT, {
      detail: { expanded },
    })
  )
}

function renderDebugPanelBody(container: HTMLElement, snapshot: WorkbenchDebugSnapshot) {
  container.innerHTML = ''
  container.append(
    createDebugPanelSection(
      `Active Task State (${formatRunningStateLabel(snapshot)})`,
      formatDebugJson(snapshot)
    ),
    createDebugPanelSection('Memory Diagnostics', formatMemoryDiagnostics(snapshot)),
    createMessageStyleComparisonSection(snapshot),
    createDebugPanelSection(
      `Debug Logs (${snapshot.logs.length}/${snapshot.logLimit})`,
      formatDebugLogs(snapshot)
    )
  )
}

function createCollapsedDebugPanel(snapshot: WorkbenchDebugSnapshot, onExpand: () => void) {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.testid = 'debug-panel-collapsed'
  button.className =
    'flex max-w-[min(420px,calc(100vw-2rem))] items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs text-text-primary shadow-2xl hover:bg-muted focus:bg-muted focus:outline-none'
  button.setAttribute('aria-label', 'Expand debug panel')
  button.addEventListener('click', onExpand)

  const dot = document.createElement('span')
  dot.className = snapshot.workbench?.runningState.activeTaskRunning
    ? 'h-2 w-2 shrink-0 rounded-full bg-primary'
    : 'h-2 w-2 shrink-0 rounded-full bg-border'

  const text = document.createElement('span')
  text.className = 'min-w-0 truncate'
  text.textContent = `Debug Panel collapsed - ${formatRunningStateLabel(snapshot)}`

  const hint = document.createElement('span')
  hint.className = 'shrink-0 text-text-muted'
  hint.textContent = 'Expand'

  button.append(dot, text, hint)
  return button
}

function formatRunningStateLabel(snapshot: WorkbenchDebugSnapshot): string {
  const workbenchRunning = snapshot.workbench?.runningState
  const paneStatus = snapshot.pane?.status
  if (!workbenchRunning?.hasCurrentRuntimeTask) return 'no active runtime task'

  return [
    `taskKnown=${workbenchRunning.activeTaskKnown}`,
    `taskRunning=${String(workbenchRunning.activeTaskRunning)}`,
    `taskStatus=${workbenchRunning.activeTaskStatus ?? 'null'}`,
    `paneRunning=${String(paneStatus?.taskExecution.running ?? null)}`,
    `paneBusy=${String(paneStatus?.isBusy ?? null)}`,
    `sendPhase=${paneStatus?.sendPhase ?? 'null'}`,
  ].join(' / ')
}

function createDebugPanelSection(title: string, content: string): HTMLElement {
  const section = document.createElement('section')
  section.className = 'flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r'

  const heading = document.createElement('div')
  heading.className = 'border-b border-border px-4 py-2 text-xs font-medium text-text-secondary'
  heading.textContent = title

  const pre = document.createElement('pre')
  pre.className =
    'min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5 text-text-primary'
  pre.textContent = content

  section.append(heading, pre)
  return section
}

function createMessageStyleComparisonSection(snapshot: WorkbenchDebugSnapshot): HTMLElement {
  const comparison = snapshot.pane?.messageStyleComparison ?? null
  const section = document.createElement('section')
  section.className = 'flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r'

  const heading = document.createElement('div')
  heading.className = 'border-b border-border px-4 py-2 text-xs font-medium text-text-secondary'
  heading.textContent = 'Transcript vs Streaming Style'

  const content = document.createElement('div')
  content.className = 'min-h-0 flex-1 overflow-auto p-4'

  if (!comparison) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted'
    empty.textContent = 'No pane snapshot has been captured yet.'
    content.appendChild(empty)
  } else {
    const cards = document.createElement('div')
    cards.className = 'grid gap-3 xl:grid-cols-2'
    cards.append(
      createMessageStyleSampleCard('Transcript Loaded', comparison.transcriptLoaded),
      createMessageStyleSampleCard('Current Streaming', comparison.currentStreaming)
    )

    const diff = document.createElement('pre')
    diff.className =
      'mt-3 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-[11px] leading-5 text-text-primary'
    diff.textContent = JSON.stringify(
      {
        fieldDiff: comparison.fieldDiff,
        renderingRules: comparison.renderingRules,
      },
      null,
      2
    )

    content.append(cards, diff)
  }

  section.append(heading, content)
  return section
}

function createMessageStyleSampleCard(
  title: string,
  sample: NonNullable<WorkbenchDebugSnapshot['pane']>['messageStyleComparison']['transcriptLoaded']
): HTMLElement {
  const card = document.createElement('div')
  card.className = 'rounded-md border border-border bg-background p-3'

  const heading = document.createElement('div')
  heading.className = 'text-xs font-semibold text-text-primary'
  heading.textContent = title

  if (!sample) {
    const empty = document.createElement('div')
    empty.className = 'mt-2 text-xs leading-5 text-text-muted'
    empty.textContent = 'No matching message in the current pane.'
    card.append(heading, empty)
    return card
  }

  const meta = document.createElement('div')
  meta.className = 'mt-2 grid gap-1 text-[11px] leading-5 text-text-secondary'
  ;[
    `id: ${sample.id}`,
    `status: ${sample.status}`,
    `runtimeStatus: ${sample.runtimeStatus ?? 'null'}`,
    `runtimeMessageIndex: ${sample.runtimeMessageIndex ?? 'null'}`,
    `subtaskId: ${sample.subtaskId ?? 'null'}`,
    `blocks: ${sample.blockCount} (${sample.runningBlockCount} running)`,
    `completedAt: ${sample.completedAt ?? 'null'}`,
  ].forEach(line => {
    const item = document.createElement('div')
    item.textContent = line
    meta.appendChild(item)
  })

  const preview = document.createElement('div')
  preview.className =
    'mt-3 max-h-32 overflow-auto rounded-md border border-border bg-surface px-3 py-2 text-[12px] leading-5 text-text-primary'
  preview.textContent = sample.contentPreview

  const uiList = document.createElement('ul')
  uiList.className = 'mt-3 list-disc space-y-1 pl-4 text-[11px] leading-5 text-text-secondary'
  sample.expectedUi.forEach(rule => {
    const item = document.createElement('li')
    item.textContent = rule
    uiList.appendChild(item)
  })

  card.append(heading, meta, preview, uiList)
  return card
}

function createDebugPanelButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className =
    'h-8 rounded-md border border-border px-3 text-xs transition-colors hover:bg-muted focus:bg-muted focus:outline-none'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function formatDebugJson(snapshot: WorkbenchDebugSnapshot): string {
  return JSON.stringify(
    {
      updatedAt: snapshot.updatedAt,
      workbench: snapshot.workbench,
      pane: snapshot.pane,
    },
    null,
    2
  )
}

function formatMemoryDiagnostics(snapshot: WorkbenchDebugSnapshot): string {
  const memory = snapshot.pane?.memory
  if (!memory) return 'No runtime pane memory snapshot has been captured yet.'

  return JSON.stringify(memory, null, 2)
}

function formatDebugLogs(snapshot: WorkbenchDebugSnapshot): string {
  if (snapshot.logs.length === 0) return 'No console.debug logs captured yet.'

  return snapshot.logs
    .map(log => {
      const message = log.args.join(' ')
      return `[${log.timestamp}] ${message}`
    })
    .join('\n')
}

async function copyDebugSnapshot(snapshot: WorkbenchDebugSnapshot) {
  const text = JSON.stringify(snapshot, null, 2)
  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    console.warn('[Wework dev] Failed to copy debug snapshot', error)
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
