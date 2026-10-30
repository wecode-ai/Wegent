import { initializeProviderModelConfiguration } from '@/features/model-settings/providerModelConfiguration'
import './i18n'
import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'prosemirror-view/style/prosemirror.css'
import '@xyflow/react/dist/style.css'
import '@wegent/collaboration/styles.css'
import './styles/globals.css'
import { RendererCrashProbe } from './e2e/RendererCrashProbe'
import { getDesktopE2ERuntimeConfig } from './e2e/runtime-config'
import App from './App.tsx'
import { WorkbenchErrorBoundary } from '@/components/common/WorkbenchErrorBoundary'
import { WorkbenchErrorPage } from '@/components/common/WorkbenchErrorPage'
import { installAppLogging } from './lib/app-logging'
import { installDebugPanelLogCapture } from './lib/debugPanel'
import { installDeveloperCommandMenu } from './lib/developerCommandMenu'
import {
  installApplicationMenuLanguageSync,
  installApplicationMenuNavigation,
} from './desktop/applicationMenu'
import { installExternalDropGuard } from './lib/external-drop-guard'
import { installExternalLinkHandler } from './lib/external-links'
import { installPageZoomGuard } from './lib/pageZoomGuard'
import { installPerformanceDiagnostics, recordReactCommit } from './lib/performanceDiagnostics'
import { installWeworkAutomationBridge } from './e2e/automation'
import { installDesktopExtensions } from '@extensions/desktop'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { installFrontendRecoveryBridge } from '@/lib/frontendRecovery'
import { DshClientContextProvider } from '@/features/dsh-runtime/DshClientContextProvider'
import { initializeDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import { reportDesktopStartupFailure } from '@/desktop/startupFailure'

import type { Context } from '@deepseek-ai/cordis'

interface WeworkAppRuntime {
  mount(container: HTMLElement, context: Context): Promise<() => void>
}

const rendererStartupStartedAt = performance.now()

function logRendererStartupStep(
  step: string,
  status: 'started' | 'completed' | 'failed',
  details: Record<string, unknown> = {}
): void {
  console.info('[startup][renderer]', {
    step,
    status,
    elapsedMs: Math.round(performance.now() - rendererStartupStartedAt),
    ...details,
  })
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
  if (isElectronRuntime()) {
    installApplicationMenuNavigation()
    installApplicationMenuLanguageSync()
  }
}
const performanceDiagnostics = isSystemDragPanel ? null : installPerformanceDiagnostics()

async function mountApp(container: HTMLElement, context: Context | null): Promise<() => void> {
  logRendererStartupStep('react-mount', 'started')
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <WorkbenchErrorBoundary onError={reportRendererFailure}>
        {getDesktopE2ERuntimeConfig().controlUrl && <RendererCrashProbe />}
        <DshClientContextProvider context={context}>
          {performanceDiagnostics ? (
            <Profiler id="wework-root" onRender={recordReactCommit}>
              <App />
            </Profiler>
          ) : (
            <App />
          )}
        </DshClientContextProvider>
      </WorkbenchErrorBoundary>
    </StrictMode>
  )
  logRendererStartupStep('react-mount', 'completed')
  return () => root.unmount()
}

function reportRendererFailure(error: unknown): void {
  logRendererStartupStep('renderer-startup', 'failed', {
    errorType: error instanceof Error ? error.name : typeof error,
  })
  console.error('[Wework] Desktop frontend failed:', error)
  void reportDesktopStartupFailure(error, 'renderer_mount').catch(startupError => {
    console.error('[Wework] Failed to report desktop startup failure:', startupError)
  })
}

function renderStartupFailure(container: HTMLElement, error: unknown): void {
  reportRendererFailure(error)
  createRoot(container).render(<WorkbenchErrorPage kind="startup" />)
}

const desktopStorageReady = (async () => {
  logRendererStartupStep('renderer-storage-initialize', 'started')
  try {
    await initializeDesktopLocalStoragePersistence()
    await initializeProviderModelConfiguration()
    logRendererStartupStep('renderer-storage-initialize', 'completed')
    return null
  } catch (error) {
    logRendererStartupStep('renderer-storage-initialize', 'failed', {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return error
  }
})()

async function mountWework(container: HTMLElement, context: Context | null): Promise<() => void> {
  logRendererStartupStep('wework-mount', 'started')
  const storageError = await desktopStorageReady
  if (storageError !== null) {
    renderStartupFailure(container, storageError)
    return () => {}
  }
  if (!isSystemDragPanel) {
    logRendererStartupStep('automation-bridge-install', 'started')
    try {
      await installWeworkAutomationBridge()
      logRendererStartupStep('automation-bridge-install', 'completed')
    } catch (error) {
      logRendererStartupStep('automation-bridge-install', 'failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      console.error('[Wework] Failed to install the automation bridge:', error)
    }
  }
  try {
    const unmount = await mountApp(container, context)
    logRendererStartupStep('wework-mount', 'completed')
    return unmount
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
