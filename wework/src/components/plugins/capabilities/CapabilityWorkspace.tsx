import { navigateTo } from '@/lib/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { SkillsPanel } from './SkillsPanel'
import { McpPanel } from './McpPanel'

type CapabilityTab = 'plugins' | 'skills' | 'mcp'
export function CapabilityWorkspace({
  children,
  topBarLeftActions,
  showPluginDetail,
}: {
  children: ReactNode
  topBarLeftActions?: ReactNode
  showPluginDetail: boolean
}) {
  const { t } = useTranslation('capabilities')
  const [selected, setSelected] = useState<CapabilityTab>('plugins')
  const active = showPluginDetail ? 'plugins' : selected
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-text-primary"
      data-testid="capability-workspace"
    >
      <div className="mx-auto w-full max-w-[1120px] shrink-0 px-5 pt-4 md:px-10">
        <div className="flex min-h-8 items-center gap-3">
          {topBarLeftActions}
          <h1 className="heading-medium">{t('plugins')}</h1>
          <MacOSTitleBarDragRegion className="min-h-8 flex-1" />
        </div>
        <div
          role="tablist"
          aria-label={t('capabilityTabs')}
          className="mt-3 flex gap-6 border-b border-border"
        >
          {(['plugins', 'skills', 'mcp'] as const).map((tab, index, tabs) => (
            <button
              type="button"
              key={tab}
              role="tab"
              id={`capability-tab-${tab}`}
              aria-selected={active === tab}
              aria-controls={`capability-panel-${tab}`}
              tabIndex={active === tab ? 0 : -1}
              data-testid={`capability-tab-${tab}`}
              className={`border-b-2 px-1 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${active === tab ? 'border-text-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
              onClick={() => {
                setSelected(tab)
                if (showPluginDetail) navigateTo('/plugins')
              }}
              onKeyDown={event => {
                const next =
                  event.key === 'ArrowRight'
                    ? tabs[(index + 1) % 3]
                    : event.key === 'ArrowLeft'
                      ? tabs[(index + 2) % 3]
                      : event.key === 'Home'
                        ? tabs[0]
                        : event.key === 'End'
                          ? tabs[2]
                          : null
                if (next) {
                  event.preventDefault()
                  setSelected(next)
                  if (showPluginDetail) navigateTo('/plugins')
                  document.getElementById(`capability-tab-${next}`)?.focus()
                }
              }}
            >
              {t(tab)}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id="capability-panel-plugins"
        data-testid="capability-panel-plugins"
        aria-labelledby="capability-tab-plugins"
        hidden={active !== 'plugins'}
        className={active === 'plugins' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
      >
        {children}
      </div>
      {active === 'skills' && (
        <div
          role="tabpanel"
          id="capability-panel-skills"
          data-testid="capability-panel-skills"
          aria-labelledby="capability-tab-skills"
          className="flex min-h-0 flex-1 flex-col"
        >
          <SkillsPanel onManagePlugin={() => setSelected('plugins')} />
        </div>
      )}
      {active === 'mcp' && (
        <div
          role="tabpanel"
          id="capability-panel-mcp"
          data-testid="capability-panel-mcp"
          aria-labelledby="capability-tab-mcp"
          className="flex min-h-0 flex-1 flex-col"
        >
          <McpPanel />
        </div>
      )}
    </div>
  )
}
