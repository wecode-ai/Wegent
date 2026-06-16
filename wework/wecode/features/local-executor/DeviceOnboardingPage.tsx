import { Check, CircleAlert, CircleDot, Cloud, Loader2 } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { isTauriRuntime } from '@/lib/runtime-environment'
import {
  getLocalExecutorStartupSnapshot,
  subscribeLocalExecutorStartup,
  type StartupStepTone,
} from './local-executor-startup'
import { useDeviceOnboarding } from './useDeviceOnboarding'
import { StartupStepTerminal } from './StartupStepTerminal'

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
  const { timedOut, creatingCloud, cloudCreated, cloudError, createCloudDevice, retry } =
    useDeviceOnboarding({
      onReady,
    })

  const isTauri = isTauriRuntime()

  return (
    <div className="flex h-full w-full flex-col bg-surface" data-testid="device-onboarding-page">
      {isTauri && (
        <div
          className="z-titlebar flex h-[38px] shrink-0 items-center select-none"
          data-tauri-drag-region
        >
          <div className="w-[95px] shrink-0" data-tauri-drag-region />
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
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
                    {(step.tone === 'running' || step.logs !== undefined) && (
                      <StartupStepTerminal
                        logs={step.logs ?? ''}
                        running={step.tone === 'running'}
                      />
                    )}
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
          <div
            className="rounded-lg border border-primary/25 bg-primary/5 p-4"
            data-testid="device-onboarding-cloud"
          >
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
                <Cloud className="h-4 w-4" />
              </span>
              <span className="text-sm font-semibold text-text-primary">
                {cloudError ? '云端设备创建失败' : '云端设备创建中'}
              </span>
              {cloudError ? (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-500">
                  <CircleAlert className="h-3 w-3" />
                  失败
                </span>
              ) : (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {cloudCreated ? '部署中' : '创建中'}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-4 text-text-muted">
              {cloudError
                ? '云端设备创建请求失败，可重试。'
                : cloudCreated
                  ? '云设备正在创建中，预计 1-3 分钟后可用，就绪后会自动进入主界面，请稍候...'
                  : '正在为你提交云端设备创建请求...'}
            </p>
            <ul className="mt-3 grid gap-2">
              {[
                '无需本机环境，关机也能持续运行任务',
                '随时随地接入，换设备也能无缝继续',
                '免维护、自动更新，省去本地配置烦恼',
              ].map(benefit => (
                <li key={benefit} className="flex gap-2 text-xs leading-4 text-text-secondary">
                  <Check className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
            {cloudError && (
              <div className="mt-3 flex items-center gap-2">
                <p className="text-xs text-red-500" data-testid="device-onboarding-cloud-error">
                  {cloudError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={createCloudDevice}
                  disabled={creatingCloud}
                  data-testid="device-onboarding-create-cloud-button"
                >
                  重试
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
