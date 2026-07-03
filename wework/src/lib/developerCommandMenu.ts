import { invoke } from '@tauri-apps/api/core'
import {
  isPerformanceDiagnosticsEnabled,
  isPerformanceDiagnosticsShortcut,
  setPerformanceDiagnosticsEnabled,
} from './performanceDiagnostics'
import { isTauriRuntime } from './runtime-environment'

const MENU_ID = 'wework-developer-command-menu'
const INSPECTOR_COMMAND = 'open_main_webview_devtools'
const OPEN_LOG_DIRECTORY_COMMAND = 'open_app_log_directory'

interface DeveloperCommand {
  id: string
  label: string
  description: string
  run: () => void | Promise<void>
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

function openDeveloperCommandMenu() {
  closeDeveloperCommandMenu()

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

  dialog.append(header, list)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeDeveloperCommandMenu()
  })
  overlay.addEventListener('keydown', handleMenuKeyDown)
}

function closeDeveloperCommandMenu() {
  document.getElementById(MENU_ID)?.remove()
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

function getDeveloperCommands(): DeveloperCommand[] {
  const diagnosticsEnabled = isPerformanceDiagnosticsEnabled()
  return [
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
