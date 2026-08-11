import { Check, ChevronDown, CircleAlert, CircleDot } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { navigateTo } from '@/lib/navigation'
import {
  getLocalExecutorStartupSnapshot,
  startLocalExecutorStartupCheck,
  subscribeLocalExecutorStartup,
  type StartupStepTone,
} from './local-executor-startup'

const stepIconByTone: Record<StartupStepTone, typeof Check> = {
  pending: CircleDot,
  running: CircleDot,
  success: Check,
  warning: CircleAlert,
  error: CircleAlert,
}

export function LocalExecutorStartupIndicator() {
  const startup = useSyncExternalStore(
    subscribeLocalExecutorStartup,
    getLocalExecutorStartupSnapshot,
    getLocalExecutorStartupSnapshot
  )
  const [open, setOpen] = useState(false)
  const stepsRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void startLocalExecutorStartupCheck()
  }, [])

  useEffect(() => {
    const element = stepsRef.current
    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }, [startup.steps])

  useEffect(() => {
    if (!open) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!indicatorRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const openLocalManagement = () => {
    setOpen(false)
    navigateTo('/local-management')
  }

  return (
    <div ref={indicatorRef} className="relative" data-testid="local-startup-indicator">
      <div
        className={`relative flex h-7 w-fit max-w-[168px] items-center rounded-md text-[11px] font-medium transition ${
          open
            ? 'bg-black/[0.035] text-text-secondary'
            : startup.tone === 'error'
              ? 'text-red-500/70 hover:bg-red-500/[0.04]'
              : startup.tone === 'success'
                ? 'opacity-0 hover:bg-black/[0.025] hover:text-text-secondary hover:opacity-100 focus-within:opacity-100'
                : 'text-text-muted/60 hover:bg-black/[0.025] hover:text-text-secondary'
        }`}
      >
        <button
          type="button"
          data-testid="local-startup-open-management-button"
          onClick={openLocalManagement}
          className="min-w-0 truncate py-1 pl-2 pr-1 text-left"
          title={startup.label}
        >
          {startup.label}
        </button>
        <button
          type="button"
          data-testid="local-startup-details-button"
          aria-label="查看本机初始化详情"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          className="grid h-7 w-5 shrink-0 place-items-center rounded-md hover:bg-black/[0.035]"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {startup.tone === 'checking' && (
          <span className="absolute bottom-0 left-2 right-5 h-px overflow-hidden bg-black/[0.04]">
            <span
              className="block h-full bg-primary/60 transition-[width] duration-300"
              style={{ width: `${startup.progress}%` }}
            />
          </span>
        )}
      </div>

      {open && (
        <section
          data-testid="local-startup-details"
          className="absolute right-0 top-8 z-popover w-[344px] overflow-hidden rounded-lg border border-border/80 bg-background/95 shadow-[0_12px_32px_rgba(0,0,0,0.12)] backdrop-blur-xl"
        >
          <header className="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
            <strong className="text-xs font-semibold text-text-primary">本机初始化</strong>
            <span className="text-[10px] text-text-muted">App 启动时检测一次</span>
          </header>
          <div ref={stepsRef} className="h-48 overflow-y-auto py-1 scroll-smooth">
            {startup.steps.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-text-muted">正在准备检测...</div>
            ) : (
              startup.steps.map(step => {
                const Icon = stepIconByTone[step.tone]
                return (
                  <div
                    key={step.id}
                    className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 px-3 py-2"
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
                      <div className="text-[11px] font-semibold leading-4 text-text-secondary">
                        {step.title}
                      </div>
                      <div className="mt-0.5 break-words text-[10px] leading-4 text-text-muted">
                        {step.detail}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
          <footer className="flex items-center justify-between border-t border-border/60 bg-muted/30 px-3 py-2">
            <span className="text-[10px] text-text-muted">{startup.label}</span>
            <button
              type="button"
              data-testid="local-startup-manage-button"
              onClick={openLocalManagement}
              className="text-[10px] font-semibold text-primary/80 hover:text-primary"
            >
              本机管理 →
            </button>
          </footer>
        </section>
      )}
    </div>
  )
}
