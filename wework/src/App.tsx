import { AppPreferencesProvider } from '@/features/app-preferences/AppPreferencesProvider'
import { AppUpdateProvider } from '@/features/app-update/AppUpdateProvider'
import { AppearanceProvider } from '@/features/appearance'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { ComputerUseActivityIndicator } from '@/features/computer-use/ComputerUseActivityIndicator'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { SystemDragPanel } from '@/features/system-drag/SystemDragPanel'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { ProcessExplorerPage } from '@/pages/ProcessExplorerPage'
import { TelemetryBridge } from '@/telemetry/TelemetryBridge'
import type { ReactNode } from 'react'
import { AppShell } from './AppShell'
import { useCurrentPath } from './appLocation'
import { isPopoutWindowRuntime } from './appWindowIdentity'
export { WorkspaceTabSurface } from './AppWorkspaceRoutes'

export default function App() {
  const path = useCurrentPath()
  const content =
    isDesktopRuntime() && path === '/system-drag' ? (
      <SystemDragPanel />
    ) : isDesktopRuntime() && path === '/process-explorer' ? (
      <ProcessExplorerPage />
    ) : (
      <MainApp />
    )
  return (
    <AppEnvironment
      persistAppearance={
        !isDesktopRuntime() ||
        (!['/system-drag', '/process-explorer'].includes(path) && !isPopoutWindowRuntime())
      }
    >
      <DshSlotSurface className="contents" slot={WEWORK_DSH_SLOTS.shellBefore} />
      {content}
      <ComputerUseActivityIndicator />
      <DshSlotSurface className="contents" slot={WEWORK_DSH_SLOTS.shellAfter} />
      <div className="pointer-events-none fixed inset-0 z-system-popover">
        <DshContributionSlotSurface
          attachedClassName="contents"
          slot={WEWORK_DSH_SLOTS.shellOverlay}
        />
      </div>
    </AppEnvironment>
  )
}

function MainApp() {
  return (
    <AppUpdateProvider>
      <CloudConnectionProvider>
        <AuthProvider>
          <TelemetryBridge />
          <AppShell />
        </AuthProvider>
      </CloudConnectionProvider>
    </AppUpdateProvider>
  )
}

function AppEnvironment({
  children,
  persistAppearance = true,
}: {
  children: ReactNode
  persistAppearance?: boolean
}) {
  return (
    <AppearanceProvider persist={persistAppearance}>
      <AppPreferencesProvider>{children}</AppPreferencesProvider>
    </AppearanceProvider>
  )
}
