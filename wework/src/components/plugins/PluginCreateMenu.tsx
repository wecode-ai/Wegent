import { AtSign, ChevronDown, Circle, Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export function PluginCreateMenu({
  isOpen,
  onToggle,
  onCreatePlugin,
  onAddMarket,
  onRecordSkill,
  buttonTestId = 'plugins-create-button',
  compact = false,
}: {
  isOpen: boolean
  onToggle: () => void
  onCreatePlugin?: () => void
  onAddMarket?: () => void
  onRecordSkill?: () => void
  buttonTestId?: string
  compact?: boolean
}) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      onToggle()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onToggle])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid={buttonTestId}
        aria-expanded={isOpen}
        aria-label={compact ? t('workbench.plugins_create', '创建') : undefined}
        className={cn(
          'plugin-market-action-button',
          compact && 'h-11 w-11 min-w-[44px] justify-center gap-0 rounded-xl px-0 md:h-11'
        )}
        onClick={onToggle}
      >
        {compact ? (
          <Plus className="h-5 w-5" />
        ) : (
          <>
            <Plus className="h-[17px] w-[17px]" aria-hidden="true" />
            {t('workbench.plugins_create', '创建')}
            <ChevronDown className="h-[17px] w-[17px]" aria-hidden="true" />
          </>
        )}
      </button>
      {isOpen && (
        <div
          data-testid="plugins-create-menu"
          className="absolute right-0 top-8 z-popover isolate w-40 overflow-hidden rounded-xl border border-border bg-[rgb(var(--color-popover))] p-1 text-text-primary shadow-2xl ring-1 ring-border"
        >
          {onCreatePlugin && (
            <button
              type="button"
              data-testid="plugins-create-plugin-option"
              className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
              onClick={onCreatePlugin}
            >
              <AtSign className="h-4 w-4 text-text-secondary" />
              {t('workbench.plugins_create_plugin', '创建插件')}
            </button>
          )}
          {onAddMarket && (
            <button
              type="button"
              data-testid="plugins-add-market-option"
              className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
              onClick={onAddMarket}
            >
              <Plus className="h-4 w-4 text-primary" />
              {t('workbench.plugins_add_market', '添加插件市场')}
            </button>
          )}
          {onRecordSkill && (
            <button
              type="button"
              data-testid="plugins-record-skill-option"
              className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
              onClick={onRecordSkill}
            >
              <Circle className="h-4 w-4 text-red-500" />
              {t('workbench.plugins_record_skill', '录制技能')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
