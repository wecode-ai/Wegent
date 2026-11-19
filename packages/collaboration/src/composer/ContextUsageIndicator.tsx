import { composerIconActionDensity } from '../controls/recipes'
import type { RuntimeContextUsage } from '@wegent/chat-core/runtime'
import {
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  runtimeContextUsageMetrics,
} from '@wegent/chat-core/runtime-context-usage'
import { FileArchive, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../controls/Popover'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../controls/HoverCard'
import { controlPopup } from '../controls/recipes'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { Button as ControlButton } from '../markdown/Button'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'

export interface ContextUsageIndicatorProps {
  translate: CollaborationTranslate
  compactionThreshold?: number
  usage?: RuntimeContextUsage
  disabled?: boolean
  onCompactContext?: () => void
}

export function ContextUsageIndicator({
  usage,
  translate: t,
  compactionThreshold = DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  disabled = false,
  onCompactContext,
}: ContextUsageIndicatorProps) {
  const portalTheme = useCollaborationPortalTheme()
  const metrics = useMemo(() => (usage ? runtimeContextUsageMetrics(usage) : null), [usage])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)
  if (!usage || !metrics) return null
  const overThreshold = metrics.usedPercent >= compactionThreshold
  const handleCompact = () => {
    setConfirmOpen(false)
    setHintOpen(false)
    onCompactContext?.()
  }
  return (
    <div
      className="flex h-4 w-4 shrink-0 items-center justify-center max-md:h-11 max-md:w-11"
      data-testid="context-usage-indicator"
      aria-label={t('workbench.context_usage_aria', undefined, {
        usedPercent: metrics.usedPercent,
        remainingPercent: metrics.remainingPercent,
      })}
    >
      <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
        <HoverCard open={hintOpen && !confirmOpen} onOpenChange={setHintOpen}>
          <HoverCardTrigger render={<span className="inline-flex" />}>
            <PopoverTrigger
              render={<button type="button" />}
              data-testid="context-usage-button"
              disabled={disabled || !onCompactContext}
              aria-label={t('workbench.compact_context_prompt', '是否压缩上下文?')}
              className={cn(
                composerIconActionDensity +
                  ' context-usage-compact-trigger flex items-center justify-center rounded-full disabled:cursor-default',
                overThreshold ? 'text-destructive' : 'text-text-muted'
              )}
            >
              <span
                className={cn(
                  'context-usage-compact-visual flex h-3 w-3 items-center justify-center rounded-full',
                  overThreshold ? 'text-red-500' : 'text-text-muted'
                )}
                style={{
                  background: `conic-gradient(currentColor ${metrics.usedPercent * 3.6}deg, rgb(var(--color-border) / 0.7) 0deg)`,
                }}
              >
                <span className="h-2 w-2 rounded-full bg-background" />
              </span>
            </PopoverTrigger>
          </HoverCardTrigger>
          <HoverCardContent
            {...portalTheme}
            data-testid="context-usage-details"
            aria-label={t('workbench.context_usage_title')}
            side="top"
            sideOffset={8}
            collisionPadding={8}
            className={cn(portalTheme.className, controlPopup, 'w-max p-3 text-center')}
          >
            <div className="mb-1 whitespace-nowrap font-light text-text-secondary">
              {t('workbench.context_usage_title')}
            </div>
            <div className="whitespace-nowrap font-light">
              {t('workbench.context_usage_percent', undefined, {
                usedPercent: metrics.usedPercent,
                remainingPercent: metrics.remainingPercent,
              })}
            </div>
            <div className="whitespace-nowrap font-light">
              {t('workbench.context_usage_tokens', undefined, {
                usedTokens: formatCompactTokens(metrics.usedTokens),
                totalTokens: formatCompactTokens(metrics.totalTokens),
              })}
            </div>
            {overThreshold && !disabled && onCompactContext && (
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="context-usage-compact-hint"
                onClick={() => {
                  setHintOpen(false)
                  setConfirmOpen(true)
                }}
                className="mt-1.5 flex items-center justify-center gap-1 whitespace-nowrap font-light text-red-500 hover:underline max-md:min-h-11 max-md:min-w-11"
              >
                <FileArchive className="h-3.5 w-3.5" />
                {t('workbench.context_usage_compact_hint')}
              </ControlButton>
            )}
          </HoverCardContent>
        </HoverCard>
        <PopoverContent
          {...portalTheme}
          aria-label={t('workbench.compact_context_prompt', '是否压缩上下文?')}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          data-testid="compact-context-confirm-popover"
          className={cn(portalTheme.className, controlPopup, 'w-64 p-3')}
        >
          <div className="mb-3 pr-7 max-md:pr-11">
            <div className="font-medium">
              {t('workbench.compact_context_prompt', '是否压缩上下文?')}
            </div>
            <div className="mt-0.5 text-xs leading-[18px] text-text-secondary">
              {t('workbench.compact_context_hint', '将当前长对话压缩成更短的上下文。')}
            </div>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="cancel-compact-context-button"
            onClick={() => {
              setConfirmOpen(false)
              setHintOpen(false)
            }}
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-muted hover:text-text-primary max-md:h-11 max-md:w-11"
            aria-label={t('workbench.cancel', '取消')}
          >
            <X className="h-3.5 w-3.5" />
          </ControlButton>
          <div className="flex items-center justify-end gap-1.5">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="dismiss-compact-context-button"
              onClick={() => setConfirmOpen(false)}
              className="inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary max-md:min-h-11 max-md:min-w-11"
            >
              {t('workbench.cancel', '取消')}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              type="button"
              data-testid="confirm-compact-context-button"
              onClick={handleCompact}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-text-primary px-2.5 text-xs font-medium text-background hover:bg-text-primary/90 max-md:min-h-11 max-md:min-w-11"
            >
              <FileArchive className="h-3.5 w-3.5" />
              <span>{t('workbench.compact_context', '压缩')}</span>
            </ControlButton>
          </div>
        </PopoverContent>
      </Popover>
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
