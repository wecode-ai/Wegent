import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  isRuntimeChatStreamDebugEnabled,
  setRuntimeChatStreamDebugEnabled,
} from '@/stream/runtimeStreamDiagnostics'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { APP_UPDATE_SIMULATE_EVENT } from '@/features/app-update/app-update-context'
import { DebugPanel, DeveloperCommands, type DeveloperCommand } from './developerCommandSurfaces'
import { setEmbeddedBrowserOcclusion } from './embedded-browser'
import {
  isPerformanceDiagnosticsEnabled,
  isPerformanceDiagnosticsShortcut,
  setPerformanceDiagnosticsEnabled,
} from './performanceDiagnostics'
import { isElectronRuntime } from './runtime-environment'

import { type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const MENU_ID = 'wework-developer-command-menu'
const DEBUG_PANEL_ID = 'wework-debug-panel'
const DEBUG_PANEL_VISIBILITY_EVENT = 'wework:debug-panel-visibility-change'
const INSPECTOR_COMMAND = 'developer.openDevTools'
const OPEN_LOG_DIRECTORY_COMMAND = 'developer.openLogDirectory'
const CODEX_STREAM_DEBUG_GET_METHOD = 'runtime.codex.stream_debug.get'
const CODEX_STREAM_DEBUG_SET_METHOD = 'runtime.codex.stream_debug.set'
const DEVELOPER_COMMAND_MENU_OCCLUSION_ID = 'developer-command-menu'
const DEBUG_PANEL_OCCLUSION_ID = 'debug-panel'

interface CodexStreamDebugState {
  enabled: boolean
}
let codexStreamDebugEnabled: boolean | null = null
let codexStreamDebugLoad: Promise<void> | null = null
const roots = new Map<string, { root: Root; container: HTMLDivElement }>()
function mount(id: string, element: ReactNode) {
  const container = document.createElement('div')
  container.id = id
  document.body.append(container)
  const root = createRoot(container)
  roots.set(id, { root, container })
  root.render(element)
}
function unmount(id: string) {
  const mounted = roots.get(id)
  if (!mounted) return
  roots.delete(id)
  queueMicrotask(() => {
    mounted.root.unmount()
    mounted.container.remove()
  })
}
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
export function openDeveloperCommandMenu() {
  closeDeveloperCommandMenu()
  setEmbeddedBrowserOcclusion(DEVELOPER_COMMAND_MENU_OCCLUSION_ID, true)
  mount(
    MENU_ID,
    <DeveloperCommands
      getCommands={getDeveloperCommands}
      refreshStatus={refreshCodexStreamDebugStatus}
      close={closeDeveloperCommandMenu}
    />
  )
}
function closeDeveloperCommandMenu() {
  unmount(MENU_ID)
  setEmbeddedBrowserOcclusion(DEVELOPER_COMMAND_MENU_OCCLUSION_ID, false)
}

function getDeveloperCommands(): DeveloperCommand[] {
  const diagnosticsEnabled = isPerformanceDiagnosticsEnabled()
  const streamDebugKnown = codexStreamDebugEnabled !== null
  const streamLogsEnabled = isRuntimeChatStreamDebugEnabled() || (codexStreamDebugEnabled ?? false)
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
        console.info('[Wework perf] snapshot', JSON.stringify(window.__WEWORK_PERF__.snapshot()))
      },
    },
    {
      id: 'open-log-directory',
      label: 'Open Log Directory',
      description: 'Open the folder that contains Electron and frontend logs.',
      run: async () => {
        if (!isElectronRuntime()) {
          console.warn('[Wework dev] Log directory is only available in the Electron app.')
          return
        }
        await invokeDesktopHost(OPEN_LOG_DIRECTORY_COMMAND).catch(error => {
          console.error('[Wework dev] Failed to open log directory', error)
        })
      },
    },
    {
      id: 'open-web-inspector',
      label: 'Open Web Inspector',
      description: 'Capture JavaScript heap snapshots and allocation profiles.',
      run: async () => {
        if (!isElectronRuntime()) {
          console.warn('[Wework dev] Web Inspector is only available in the Electron app.')
          return
        }
        await invokeDesktopHost(INSPECTOR_COMMAND).catch(error => {
          console.error('[Wework dev] Failed to open Web Inspector', error)
        })
      },
    },
  ]
}

async function refreshCodexStreamDebugStatus(onLoaded?: () => void) {
  if (!isElectronRuntime()) return
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
  if (!isElectronRuntime()) {
    setRuntimeChatStreamDebugEnabled(!isRuntimeChatStreamDebugEnabled())
    console.info(
      `[Wework dev] Frontend stream logs ${isRuntimeChatStreamDebugEnabled() ? 'enabled' : 'disabled'}.`
    )
    return
  }

  if (codexStreamDebugEnabled === null) {
    await refreshCodexStreamDebugStatus()
  }
  const frontendWasEnabled = isRuntimeChatStreamDebugEnabled()
  const enabled = !(frontendWasEnabled || (codexStreamDebugEnabled ?? false))
  setRuntimeChatStreamDebugEnabled(enabled)
  try {
    const state = await requestLocalExecutor<CodexStreamDebugState>(CODEX_STREAM_DEBUG_SET_METHOD, {
      enabled,
    })
    codexStreamDebugEnabled = state.enabled
    console.info(`[Wework dev] Stream logs ${state.enabled ? 'enabled' : 'disabled'}.`)
  } catch (error) {
    setRuntimeChatStreamDebugEnabled(frontendWasEnabled)
    console.error('[Wework dev] Failed to toggle Codex stream logs', error)
  }
}

function openDebugPanel() {
  closeDebugPanel()
  mount(
    DEBUG_PANEL_ID,
    <DebugPanel close={closeDebugPanel} emitVisibility={emitDebugPanelVisibility} />
  )
}
function closeDebugPanel() {
  unmount(DEBUG_PANEL_ID)
  emitDebugPanelVisibility(false)
}
function emitDebugPanelVisibility(expanded: boolean) {
  document.body.toggleAttribute('data-wework-debug-panel-expanded', expanded)
  setEmbeddedBrowserOcclusion(DEBUG_PANEL_OCCLUSION_ID, expanded)
  window.dispatchEvent(new CustomEvent(DEBUG_PANEL_VISIBILITY_EVENT, { detail: { expanded } }))
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const id of roots.keys()) unmount(id)
    setEmbeddedBrowserOcclusion(DEVELOPER_COMMAND_MENU_OCCLUSION_ID, false)
    emitDebugPanelVisibility(false)
  })
}
