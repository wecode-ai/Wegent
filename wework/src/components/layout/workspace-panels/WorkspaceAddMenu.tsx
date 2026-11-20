import { track } from '@/telemetry/client'
import type { AnalyticsEventMap } from '@/telemetry/events'
import { ActionMenu } from '@wegent/collaboration/controls/ActionMenu'
import { Plus } from 'lucide-react'
import type { ComponentType } from 'react'
const WORKSPACE_PANEL_TYPES = new Set(['review', 'terminal', 'browser', 'chat', 'files'] as const)
function workspacePanelType(id: string) {
  return WORKSPACE_PANEL_TYPES.has(id as never)
    ? (id as 'review' | 'terminal' | 'browser' | 'chat' | 'files')
    : 'other'
}

export interface WorkspaceAddMenuItem {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect: () => void | Promise<void>
  testId?: string
  disabled?: boolean
  shortcut?: string
  title?: string
  telemetryPanel?: AnalyticsEventMap['workspace_panel_added']['panel']
}

interface WorkspaceAddMenuProps {
  ariaLabel: string
  buttonTestId?: string
  menuTestId?: string
  items: WorkspaceAddMenuItem[]
  buttonClassName: string
  preferredPlacement?: 'above' | 'below'
  align?: 'start' | 'end'
}

export function WorkspaceAddMenu({
  ariaLabel,
  buttonTestId,
  menuTestId,
  items,
  buttonClassName,
  preferredPlacement = 'below',
  align = 'start',
}: WorkspaceAddMenuProps) {
  return (
    <ActionMenu
      ariaLabel={ariaLabel}
      testId={buttonTestId}
      menuTestId={menuTestId}
      icon={Plus}
      triggerClassName={buttonClassName}
      placement={
        preferredPlacement === 'above'
          ? align === 'end'
            ? 'top-end'
            : 'top-start'
          : align === 'end'
            ? 'bottom-end'
            : 'bottom-start'
      }
      width={240}
      items={items.map(item => ({
        id: item.id,
        testId: item.testId,
        label: item.label,
        description: item.title,
        icon: item.icon,
        shortcut: item.shortcut,
        disabled: item.disabled,
        onSelect: () => {
          void Promise.resolve()
            .then(item.onSelect)
            .then(() =>
              track('workspace_panel_added', {
                panel: item.telemetryPanel ?? workspacePanelType(item.id),
              })
            )
            .catch(error => console.error('Failed to add workspace panel', error))
        },
      }))}
    />
  )
}
