import { Boxes, ChevronDown, Server, Sparkles } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function PluginCreateMenu({
  isOpen,
  onToggle,
  onCreateSkill,
  onCreateMcp,
  onCreatePlugin,
  buttonTestId = 'plugins-create-button',
}: {
  isOpen: boolean
  onToggle: () => void
  onCreateSkill: () => void
  onCreateMcp: () => void
  onCreatePlugin?: () => void
  buttonTestId?: string
}) {
  const { t } = useTranslation('common')

  return (
    <div className="relative">
      <button
        type="button"
        data-testid={buttonTestId}
        aria-expanded={isOpen}
        className="flex h-9 items-center gap-2 rounded-xl bg-surface px-3 text-sm font-semibold text-text-primary hover:bg-muted"
        onClick={onToggle}
      >
        {t('workbench.plugins_create', '创建')}
        <ChevronDown className="h-4 w-4" />
      </button>
      {isOpen && (
        <div
          data-testid="plugins-create-menu"
          className="absolute right-0 top-11 z-[100] isolate w-40 overflow-hidden rounded-xl border border-border bg-[rgb(var(--color-popover))] p-1 text-text-primary shadow-2xl ring-1 ring-border"
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
