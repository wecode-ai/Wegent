import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { installDeveloperCommandMenu } from './developerCommandMenu'

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

describe('developerCommandMenu', () => {
  beforeAll(() => {
    installDeveloperCommandMenu()
  })

  beforeEach(() => {
    invokeMock.mockResolvedValue(undefined)
    isTauriRuntimeMock.mockReturnValue(true)
    localStorage.clear()
  })

  afterEach(() => {
    document.getElementById('wework-developer-command-menu')?.remove()
    vi.clearAllMocks()
  })

  test('opens the command menu with the developer shortcut', () => {
    dispatchDeveloperShortcut()

    expect(screenCommand('reload')).toBeInTheDocument()
    expect(screenCommand('toggle-performance-diagnostics')).toBeInTheDocument()
    expect(screenCommand('print-performance-snapshot')).toBeInTheDocument()
    expect(screenCommand('open-log-directory')).toBeInTheDocument()
    expect(screenCommand('open-web-inspector')).toBeInTheDocument()
  })

  test('opens the app log directory through Tauri', () => {
    dispatchDeveloperShortcut()

    screenCommand('open-log-directory').click()

    expect(invokeMock).toHaveBeenCalledWith('open_app_log_directory')
  })

  test('opens the main WebView inspector through Tauri', () => {
    dispatchDeveloperShortcut()

    screenCommand('open-web-inspector').click()

    expect(invokeMock).toHaveBeenCalledWith('open_main_webview_devtools')
  })
})

function dispatchDeveloperShortcut() {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'KeyP',
      key: 'P',
      metaKey: true,
      altKey: true,
      shiftKey: true,
    })
  )
}

function screenCommand(commandId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="developer-command-${commandId}"]`
  )
  if (!element) {
    throw new Error(`Command was not found: ${commandId}`)
  }
  return element
}
