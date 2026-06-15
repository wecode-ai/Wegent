import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import App from './App.tsx'
import { installDesktopNavigationGuard } from './lib/desktopNavigationGuard'
import { installPageZoomGuard } from './lib/pageZoomGuard'

installDesktopNavigationGuard()
installPageZoomGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
