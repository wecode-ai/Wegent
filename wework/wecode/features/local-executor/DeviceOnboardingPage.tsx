import { Check, CircleAlert, CircleDot, Cloud, Loader2 } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  getLocalExecutorStartupSnapshot,
  subscribeLocalExecutorStartup,
  type StartupStepTone,
} from './local-executor-startup'
import { useDeviceOnboarding } from './useDeviceOnboarding'

const stepIconByTone: Record<StartupStepTone, typeof Check> = {
  pending: CircleDot,
  running: CircleDot,
  success: Check,
  warning: CircleAlert,
  error: CircleAlert,
}

interface DeviceOnboardingPageProps {
  onReady: () => void
}

export function DeviceOnboardingPage({ onReady }: DeviceOnboardingPageProps) {
  const startup = useSyncExternalStore(
    subscribeLocalExecutorStartup,
    getLocalExecutorStartupSnapshot,
    getLocalExecutorStartupSnapshot
  )
  const { timedOut, creatingCloud, cloudError, createCloudDevice, retry } = useDeviceOnboarding({
    onReady,
  })

  return (
    <div
      className="flex h-full w-full items-center justify-center bg-surface px-6 py-10"
      data-testid="device-onboarding-page"
    >
      <div className="w-full max-w-md rounded-xl border border-border/70 bg-background p-6 shadow-sm">
        <header className="mb-4">
          <h1 className="text-xl font-semibold text-text-primary">正在准备你的工作环境</h1>
          <p className="mt-1 text-sm text-text-secondary">
            正在为你创建本地设备，请稍候。完成后会自动进入主界面。
          </p>
        </header>

        <div
          className="mb-5 max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-surface/60"
          data-testid="device-onboarding-steps"
        >
          {startup.steps.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-muted">正在准备检测...</div>
          ) : (
            startup.steps.map(step => {
              const Icon = stepIconByTone[step.tone]
              return (
                <div
                  key={step.id}
                  className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 px-3 py-2.5"
                >
                  <span
                    className={`mt-0.5 grid h-4 w-4 place-items-center rounded-full ${
                      step.tone === 'error'
                        ? 'bg-red-500/10 text-red-500'
                        : step.tone === 'warning'
                          ? 'bg-orange-500/10 text-orange-500'
                          : 'bg-primary/10 text-primary'
                    }`}
                  >
                    <Icon
                      className={`h-2.5 w-2.5 ${step.tone === 'running' ? 'animate-pulse' : ''}`}
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold leading-4 text-text-secondary">
                      {step.title}
                    </div>
                    <div className="mt-0.5 break-words text-[11px] leading-4 text-text-muted">
                      {step.detail}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {timedOut ? (
          <div
            className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4"
            data-testid="device-onboarding-timeout"
          >
            <p className="text-sm font-medium text-text-primary">加载设备超时</p>
            <p className="mt-1 text-xs text-text-muted">
              仍未检测到在线设备。可重试加载，或创建一个云端设备。
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                onClick={retry}
                data-testid="device-onboarding-retry-button"
              >
                重试加载设备
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>正在检测设备...</span>
          </div>
        )}

        <div className="mt-5 border-t border-border/60 pt-4">
          <p className="text-sm text-text-secondary">
            你也可以创建一个云端设备，无需本机环境即可运行任务。
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={createCloudDevice}
            disabled={creatingCloud}
            data-testid="device-onboarding-create-cloud-button"
          >
            {creatingCloud ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在创建云端设备...
              </>
            ) : (
              <>
                <Cloud className="mr-2 h-4 w-4" />
                创建云端设备
              </>
            )}
          </Button>
          {cloudError && (
            <p className="mt-2 text-xs text-red-500" data-testid="device-onboarding-cloud-error">
              {cloudError}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
