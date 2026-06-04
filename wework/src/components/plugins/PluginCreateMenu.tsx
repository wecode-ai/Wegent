import { Boxes, ChevronDown, Plus, Server, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function PluginCreateMenu({
  isOpen,
  onToggle,
  onCreateSkill,
  onCreateMcp,
  onCreatePlugin,
  buttonTestId = 'plugins-create-button',
  compact = false,
}: {
  isOpen: boolean
  onToggle: () => void
  onCreateSkill: () => void
  onCreateMcp: () => void
  onCreatePlugin?: () => void
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
        className={[
          'flex min-w-[44px] items-center justify-center gap-2 rounded-xl bg-surface text-sm font-semibold text-text-primary hover:bg-muted',
          compact ? 'h-11 w-11 px-0' : 'h-10 px-3 sm:h-9',
        ].join(' ')}
        onClick={onToggle}
      >
        {compact ? (
          <Plus className="h-5 w-5" />
        ) : (
          <>
            {t('workbench.plugins_create', '创建')}
            <ChevronDown className="h-4 w-4" />
          </>
        )}
      </button>
      {isOpen && (
        <div
          data-testid="plugins-create-menu"
          className="absolute right-0 top-11 z-popover isolate w-40 overflow-hidden rounded-xl border border-border bg-[rgb(var(--color-popover))] p-1 text-text-primary shadow-2xl ring-1 ring-border"
        >
          <button
            type="button"
            data-testid="plugins-create-skill-option"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
            onClick={onCreateSkill}
          >
            <Sparkles className="h-4 w-4 text-indigo-500" />
            {t('workbench.plugins_create_skill', '技能')}
          </button>
          <button
            type="button"
            data-testid="plugins-create-mcp-option"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
            onClick={onCreateMcp}
          >
            <Server className="h-4 w-4 text-primary" />
            {t('workbench.plugins_create_mcp', 'MCP')}
          </button>
          {onCreatePlugin && (
            <button
              type="button"
              data-testid="plugins-create-plugin-option"
              className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
              onClick={onCreatePlugin}
            >
              <Boxes className="h-4 w-4 text-violet-500" />
              {t('workbench.plugins_create_plugin', '插件')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
