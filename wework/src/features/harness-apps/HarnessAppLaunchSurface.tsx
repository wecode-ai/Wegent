import { AlertTriangle, Box, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { HarnessAppLaunchState } from './harnessAppLaunchState'

interface HarnessAppLaunchSurfaceProps {
  launch: HarnessAppLaunchState
}

export function HarnessAppLaunchSurface({ launch }: HarnessAppLaunchSurfaceProps) {
  const { t } = useTranslation('common')
  const failed = launch.status === 'failed'

  return (
    <main
      className="flex h-full min-h-0 items-center justify-center bg-background px-6"
      data-testid={`harness-app-launch-${launch.installationId}`}
    >
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border/40 bg-surface shadow-sm">
          {failed ? (
            <AlertTriangle className="h-7 w-7 text-danger" aria-hidden="true" />
          ) : (
            <Box className="h-7 w-7 text-text-secondary" aria-hidden="true" />
          )}
        </div>
        <h1 className="mt-5 text-lg font-medium text-text-primary">{launch.title}</h1>
        {failed ? (
          <>
            <p className="mt-2 text-sm text-danger">
              {launch.error ?? t('workbench.harness_apps_start_failed')}
            </p>
            <Button
              className="mt-5"
              size="sm"
              data-testid={`harness-app-launch-retry-${launch.installationId}`}
              onClick={launch.retry}
            >
              <RotateCcw className="h-4 w-4" />
              {t('workbench.harness_apps_retry', '重试')}
            </Button>
          </>
        ) : (
          <div
            className="mt-3 flex items-center gap-2 text-sm text-text-secondary"
            data-testid={`harness-app-launch-loading-${launch.installationId}`}
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{t('workbench.harness_apps_starting', '正在启动智能应用…')}</span>
          </div>
        )}
      </div>
    </main>
  )
}
