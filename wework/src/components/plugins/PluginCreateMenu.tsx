import { Boxes, ChevronDown, Plus, Server, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

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
        className={cn(
          'flex min-w-[44px] items-center justify-center text-text-primary transition-colors',
          compact
            ? 'h-11 w-11 gap-0 rounded-xl bg-surface px-0 text-sm font-semibold hover:bg-muted'
            : 'h-7 gap-1.5 rounded-lg bg-transparent px-2 text-[13px] font-medium leading-[18px] hover:bg-black/[0.06] active:bg-black/[0.10]',
        )}
        onClick={onToggle}
      >
        {compact ? (
          <Plus className="h-5 w-5" />
        ) : (
          <>
            {t('workbench.plugins_create', '创建')}
            <ChevronDown className="h-[18px] w-[18px] stroke-[2]" />
          </>
        )}
      </button>
      {isOpen && (
        <div
          data-testid="plugins-create-menu"
          className="absolute right-0 top-8 z-popover isolate w-40 overflow-hidden rounded-xl border border-border bg-[rgb(var(--color-popover))] p-1 text-text-primary shadow-2xl ring-1 ring-border"
        >
          <button
            type="button"
            data-testid="plugins-create-skill-option"
            className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
            onClick={onCreateSkill}
          >
            <Sparkles className="h-4 w-4 text-indigo-500" />
            {t('workbench.plugins_create_skill', '技能')}
          </button>
          <button
            type="button"
            data-testid="plugins-create-mcp-option"
            className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
            onClick={onCreateMcp}
          >
            <Server className="h-4 w-4 text-primary" />
            {t('workbench.plugins_create_mcp', 'MCP')}
          </button>
          {onCreatePlugin && (
            <button
              type="button"
              data-testid="plugins-create-plugin-option"
              className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-text-primary hover:bg-surface"
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
