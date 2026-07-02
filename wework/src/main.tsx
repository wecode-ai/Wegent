import './i18n'
import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import App from './App.tsx'
import { installAppLogging } from './lib/app-logging'
import { installExternalLinkHandler } from './lib/external-links'
import { installPageZoomGuard } from './lib/pageZoomGuard'
import {
  installPerformanceDiagnostics,
  installPerformanceDiagnosticsToggle,
  recordReactCommit,
} from './lib/performanceDiagnostics'
import { installDesktopExtensions } from '@extensions/desktop'

installAppLogging()
installDesktopExtensions()
installExternalLinkHandler()
installPageZoomGuard()
installPerformanceDiagnosticsToggle()
const performanceDiagnostics = installPerformanceDiagnostics()

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
