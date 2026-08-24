import {
  AlertTriangle,
  BarChart3,
  Box,
  FileText,
  PieChart,
  RotateCcw,
  UserRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { HarnessAppLaunchState } from './harnessAppLaunchState'
import styles from './HarnessAppLaunchSurface.module.css'

interface HarnessAppLaunchSurfaceProps {
  launch: HarnessAppLaunchState
}

function LaunchAnimation({ phase }: Pick<HarnessAppLaunchState, 'phase'>) {
  if (phase === 'preparingRuntime') {
    return (
      <div
        className={styles.animation}
        data-testid="harness-app-animation-preparing-runtime"
        aria-hidden="true"
      >
        <span className={styles.orbit} />
        <span className={styles.packet} />
        <span className={`${styles.core} ${styles.corePreparing}`}>
          <Box className="h-7 w-7 text-text-secondary" />
        </span>
      </div>
    )
  }

  if (phase === 'loadingApp') {
    return (
      <div
        className={styles.animation}
        data-testid="harness-app-animation-loading-app"
        aria-hidden="true"
      >
        <span className={`${styles.module} ${styles.moduleTop}`}>
          <BarChart3 className="h-4 w-4" />
        </span>
        <span className={`${styles.module} ${styles.moduleRight}`}>
          <PieChart className="h-4 w-4" />
        </span>
        <span className={`${styles.module} ${styles.moduleBottom}`}>
          <UserRound className="h-4 w-4" />
        </span>
        <span className={`${styles.module} ${styles.moduleLeft}`}>
          <FileText className="h-4 w-4" />
        </span>
        <span className={`${styles.core} ${styles.coreLoading}`}>
          <Box className="h-7 w-7 text-text-secondary" />
        </span>
      </div>
    )
  }

  return (
    <div
      className={styles.animation}
      data-testid="harness-app-animation-starting-app"
      aria-hidden="true"
    >
      <span className={styles.pulse} />
      <span className={`${styles.pulse} ${styles.pulseDelayed}`} />
      <span className={styles.lid} />
      <span className={`${styles.core} ${styles.coreStarting}`}>
        <Box className="h-7 w-7 text-text-secondary" />
      </span>
    </div>
  )
}

export function HarnessAppLaunchSurface({ launch }: HarnessAppLaunchSurfaceProps) {
  const { t } = useTranslation('common')
  const failed = launch.status === 'failed'
  const phases = [
    {
      id: 'preparingRuntime',
      label: t('workbench.harness_apps_phase_runtime', '准备运行环境'),
    },
    {
      id: 'loadingApp',
      label: t('workbench.harness_apps_phase_loading', '加载工作台'),
    },
    {
      id: 'startingApp',
      label: t('workbench.harness_apps_phase_starting', '启动工作台'),
    },
  ] as const
  const activePhaseIndex = phases.findIndex(phase => phase.id === launch.phase)
  const progressText = {
    preparingRuntime: t('workbench.harness_apps_preparing_runtime', {
      name: launch.title,
      defaultValue: `正在准备 ${launch.title} 的运行环境，首次启动时会自动下载…`,
    }),
    loadingApp: t('workbench.harness_apps_loading_app', {
      name: launch.title,
      defaultValue: `正在加载 ${launch.title}…`,
    }),
    startingApp: t('workbench.harness_apps_starting_app', {
      name: launch.title,
      defaultValue: `正在启动 ${launch.title}…`,
    }),
  }[launch.phase]

  return (
    <main
      className="absolute inset-0 z-10 flex min-h-0 items-center justify-center bg-background px-6"
      data-testid={`harness-app-launch-${launch.installationId}`}
    >
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="flex h-28 w-28 items-center justify-center">
          {failed ? (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border/40 bg-surface shadow-sm">
              <AlertTriangle className="h-7 w-7 text-danger" aria-hidden="true" />
            </div>
          ) : (
            <LaunchAnimation phase={launch.phase} />
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
            className="mt-3 flex flex-col items-center gap-4 text-sm text-text-secondary"
            data-testid={`harness-app-launch-loading-${launch.installationId}`}
            aria-live="polite"
          >
            <span>{progressText}</span>
            <div className="flex items-center gap-3" aria-hidden="true">
              {phases.map((phase, index) => (
                <div key={phase.id} className="flex items-center gap-2">
                  <span
                    className={[
                      'h-2 w-2 rounded-full transition-colors',
                      index < activePhaseIndex
                        ? 'bg-text-primary'
                        : index === activePhaseIndex
                          ? 'animate-pulse bg-text-primary'
                          : 'bg-border',
                    ].join(' ')}
                  />
                  <span
                    className={
                      index === activePhaseIndex ? 'text-text-primary' : 'text-text-tertiary'
                    }
                  >
                    {phase.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
