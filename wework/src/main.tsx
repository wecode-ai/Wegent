import './i18n'
import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'prosemirror-view/style/prosemirror.css'
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
import { isTauriRuntime } from '@/lib/runtime-environment'
import { installFrontendRecoveryBridge } from '@/lib/frontendRecovery'
import { hydrateLocalModelApiKeys } from '@/features/model-settings/localModelSettings'

const isSystemDragPanel = isTauriRuntime() && window.location.pathname === '/system-drag'
if (!isSystemDragPanel) {
  installDebugPanelLogCapture()
  installAppLogging()
  installFrontendRecoveryBridge()
  installDesktopExtensions()
  if (isTauriRuntime()) {
    installExternalDropGuard()
  }
  installExternalLinkHandler()
  installPageZoomGuard()
  installDeveloperCommandMenu()
}
const performanceDiagnostics = isSystemDragPanel ? null : installPerformanceDiagnostics()

async function renderApp(): Promise<void> {
  if (!isSystemDragPanel) {
    try {
      await hydrateLocalModelApiKeys()
    } catch (error) {
      console.error('Failed to restore local model credentials', error)
    }
    await installWeworkAutomationBridge()
  }
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

void renderApp()
