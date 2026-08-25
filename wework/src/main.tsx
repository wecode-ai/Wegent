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
import { initializeWorkbenchPluginRuntime } from '@/plugin-runtime/bootstrap'

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

function renderApp(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {performanceDiagnostics ? (
        <Profiler id="wework-root" onRender={recordReactCommit}>
          <App />
        </Profiler>
      ) : (
        <App />
      )}
    </StrictMode>
  )
}

function renderStartupFailure(error: unknown): void {
  console.error('[Wework] Failed to initialize the plugin runtime:', error)
  createRoot(document.getElementById('root')!).render(
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

let shouldRenderApp = true
if (!isSystemDragPanel) {
  try {
    await installWeworkAutomationBridge()
  } catch (error) {
    console.error('[Wework] Failed to install the automation bridge:', error)
  }
  try {
    await initializeWorkbenchPluginRuntime()
  } catch (error) {
    renderStartupFailure(error)
    shouldRenderApp = false
  }
}
if (shouldRenderApp) renderApp()
