import { FileArchive, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import { cn } from '@/lib/utils'
import type { RuntimeContextUsage } from '@/types/api'

interface ContextUsageIndicatorProps {
  usage?: RuntimeContextUsage
  disabled?: boolean
  onCompactContext?: () => void
}

interface ConfirmPosition {
  left: number
  top: number
}

const CONFIRM_WIDTH = 216
const CONFIRM_GAP = 10
const VIEWPORT_PADDING = 8

export function ContextUsageIndicator({
  usage,
  disabled = false,
  onCompactContext,
}: ContextUsageIndicatorProps) {
  const { t } = useTranslation('common')
  const metrics = useMemo(() => (usage ? runtimeContextUsageMetrics(usage) : null), [usage])
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmPosition, setConfirmPosition] = useState<ConfirmPosition | null>(null)

  useEffect(() => {
    if (!confirmOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setConfirmOpen(false)
        setConfirmPosition(null)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConfirmOpen(false)
        setConfirmPosition(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [confirmOpen])

  useLayoutEffect(() => {
    if (!confirmOpen) return

    const updatePosition = () => {
      const trigger = containerRef.current
      const popover = popoverRef.current
      if (!trigger) return

      const triggerRect = trigger.getBoundingClientRect()
      const popoverHeight = popover?.getBoundingClientRect().height ?? 92
      const maxLeft = window.innerWidth - CONFIRM_WIDTH - VIEWPORT_PADDING
      const left = Math.max(VIEWPORT_PADDING, Math.min(triggerRect.right - CONFIRM_WIDTH, maxLeft))
      const top = Math.max(VIEWPORT_PADDING, triggerRect.top - popoverHeight - CONFIRM_GAP)

      setConfirmPosition({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [confirmOpen])

  if (!usage || !metrics) return null

  const handleCompact = () => {
    setConfirmOpen(false)
    setConfirmPosition(null)
    onCompactContext?.()
  }

  return (
    <div
      ref={containerRef}
      className="group relative flex h-4 w-4 shrink-0 translate-y-[1px] items-center justify-center"
      data-testid="context-usage-indicator"
      aria-label={t('workbench.context_usage_aria', {
        usedPercent: metrics.usedPercent,
        remainingPercent: metrics.remainingPercent,
      })}
    >
      <button
        type="button"
        data-testid="context-usage-button"
        disabled={disabled || !onCompactContext}
        onClick={() => {
          setConfirmPosition(null)
          setConfirmOpen(current => !current)
        }}
        className={cn(
          'context-usage-compact-trigger flex h-4 w-4 items-center justify-center rounded-full disabled:cursor-default',
          metrics.usedPercent >= 85 ? 'text-red-500' : 'text-[#a5abb2]'
        )}
        aria-label={t('workbench.compact_context_prompt', '是否压缩上下文?')}
      >
        <span
          className={cn(
            'context-usage-compact-visual flex h-3 w-3 items-center justify-center rounded-full',
            metrics.usedPercent >= 85 ? 'text-red-500' : 'text-[#a5abb2]'
          )}
          style={{
            background: `conic-gradient(currentColor ${metrics.usedPercent * 3.6}deg, #edf0f2 0deg)`,
          }}
        >
          <span className="h-2 w-2 rounded-full bg-background" />
        </span>
      </button>
      {!confirmOpen && (
        <>
          <div className="pointer-events-auto absolute bottom-4 left-1/2 z-system-popover hidden h-3 w-24 -translate-x-1/2 cursor-default group-hover:block group-focus-within:block" />
          <div className="pointer-events-auto absolute bottom-7 left-1/2 z-system-popover hidden w-max -translate-x-1/2 cursor-default rounded-2xl border border-border/70 bg-background px-4 py-3 text-center text-[13px] leading-5 text-text-primary shadow-[0_14px_42px_rgba(15,23,42,0.16)] group-hover:block group-focus-within:block">
            <div className="mb-1 whitespace-nowrap font-light text-text-secondary">
              {t('workbench.context_usage_title')}
            </div>
            <div className="whitespace-nowrap font-light">
              {t('workbench.context_usage_percent', {
                usedPercent: metrics.usedPercent,
                remainingPercent: metrics.remainingPercent,
              })}
            </div>
            <div className="whitespace-nowrap font-light">
              {t('workbench.context_usage_tokens', {
                usedTokens: formatCompactTokens(metrics.usedTokens),
                totalTokens: formatCompactTokens(metrics.totalTokens),
              })}
            </div>
          </div>
        </>
      )}
      {confirmOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-testid="compact-context-confirm-popover"
            style={{
              left: confirmPosition?.left ?? 0,
              top: confirmPosition?.top ?? 0,
              visibility: confirmPosition ? 'visible' : 'hidden',
            }}
            className="pointer-events-auto fixed z-system-popover w-[13.5rem] cursor-default rounded-xl border border-border/80 bg-background p-3 text-left text-[13px] leading-5 text-text-primary shadow-[0_14px_42px_rgba(15,23,42,0.14)]"
          >
            <div className="mb-3 pr-7">
              <div className="font-medium">
                {t('workbench.compact_context_prompt', '是否压缩上下文?')}
              </div>
              <div className="mt-0.5 text-xs leading-[18px] text-text-secondary">
                {t('workbench.compact_context_hint', '将当前长对话压缩成更短的上下文。')}
              </div>
            </div>
            <button
              type="button"
              data-testid="cancel-compact-context-button"
              onClick={() => {
                setConfirmOpen(false)
                setConfirmPosition(null)
              }}
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.cancel', '取消')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                data-testid="dismiss-compact-context-button"
                onClick={() => setConfirmOpen(false)}
                className="inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                {t('workbench.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="confirm-compact-context-button"
                onClick={handleCompact}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[#1f1f1f] px-2.5 text-xs font-medium text-white hover:bg-[#333]"
              >
                <FileArchive className="h-3.5 w-3.5" />
                <span>{t('workbench.compact_context', '压缩')}</span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}m`
  if (absolute >= 1_000) return `${formatCompactNumber(value / 1_000)}k`
  return `${Math.round(value)}`
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1).replace(/\.0$/, '')
}
