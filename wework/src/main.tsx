import './i18n'
import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'prosemirror-view/style/prosemirror.css'
import '@xyflow/react/dist/style.css'
import './styles/globals.css'
import App from './App.tsx'
import { installAppLogging } from './lib/app-logging'
import { installDebugPanelLogCapture } from './lib/debugPanel'
import { installDeveloperCommandMenu } from './lib/developerCommandMenu'
import { installExternalDropGuard } from './lib/external-drop-guard'
import { installExternalLinkHandler } from './lib/external-links'
import { installPageZoomGuard } from './lib/pageZoomGuard'
import { installPerformanceDiagnostics, recordReactCommit } from './lib/performanceDiagnostics'
import { installWeworkAutomationBridge } from './e2e/automation'
import { installDesktopExtensions } from '@extensions/desktop'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { installFrontendRecoveryBridge } from '@/lib/frontendRecovery'
import { DshClientContextProvider } from '@/features/dsh-runtime/DshClientContextProvider'

import type { Context } from '@deepseek-ai/cordis'

interface WeworkAppRuntime {
  mount(container: HTMLElement, context: Context): Promise<() => void>
}

declare global {
  interface Window {
    __DSH_BOOT__?: unknown
    __WEWORK_APP_RUNTIME__?: WeworkAppRuntime
  }
}

const isSystemDragPanel = isDesktopRuntime() && window.location.pathname.endsWith('/system-drag')
if (!isSystemDragPanel) {
  installDebugPanelLogCapture()
  installAppLogging()
  installFrontendRecoveryBridge()
  installDesktopExtensions()
  if (isElectronRuntime()) {
    installExternalDropGuard()
  }
  installExternalLinkHandler()
  installPageZoomGuard()
  installDeveloperCommandMenu()
}
const performanceDiagnostics = isSystemDragPanel ? null : installPerformanceDiagnostics()

async function mountApp(container: HTMLElement, context: Context | null): Promise<() => void> {
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <DshClientContextProvider context={context}>
        {performanceDiagnostics ? (
          <Profiler id="wework-root" onRender={recordReactCommit}>
            <App />
          </Profiler>
        ) : (
          <App />
        )}
      </DshClientContextProvider>
    </StrictMode>
  )
  return () => root.unmount()
}

function renderStartupFailure(container: HTMLElement, error: unknown): void {
  console.error('[Wework] Failed to initialize the plugin runtime:', error)
  createRoot(container).render(
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground"
      data-testid="workbench-startup-error"
    >
      <section className="max-w-md space-y-4 rounded-lg border border-border bg-card p-6">
        <h1 className="heading-section">Wework 启动失败</h1>
        <p className="text-chat text-muted-foreground">
          智能工作台运行时初始化失败。请重试；如果问题持续，请打开调试面板查看日志。
        </p>
        <button
          className="rounded-md bg-primary px-3 py-2 text-primary-foreground"
          data-testid="workbench-startup-retry"
          onClick={() => window.location.reload()}
          type="button"
        >
          重新加载
        </button>
      </section>
    </main>
  )
}

async function mountWework(container: HTMLElement, context: Context | null): Promise<() => void> {
  if (!isSystemDragPanel) {
    try {
      await installWeworkAutomationBridge()
    } catch (error) {
      console.error('[Wework] Failed to install the automation bridge:', error)
    }
  }
  try {
    return await mountApp(container, context)
  } catch (error) {
    renderStartupFailure(container, error)
    return () => {}
  }
}

if (window.__DSH_BOOT__) {
  window.__WEWORK_APP_RUNTIME__ = {
    mount: (container, context) => mountWework(container, context),
  }
  window.dispatchEvent(new Event('wework:app-runtime-ready'))
} else {
  const container = document.getElementById('root')
  if (!container) throw new Error('Wework root element is missing')
  await mountWework(container, null)
}
