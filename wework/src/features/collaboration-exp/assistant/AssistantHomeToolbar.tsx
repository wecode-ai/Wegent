import { History, Settings2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { AssistantHomePanel } from './types'
import './AssistantExperience.css'

export function AssistantHomeToolbar({
  panel,
  onPanelChange,
}: {
  panel: AssistantHomePanel
  onPanelChange(panel: AssistantHomePanel): void
}) {
  const { t } = useTranslation('collaborationExp')
  return (
    <div className="assistant-header-tools">
      {(
        [
          ['recent', History, 'assistant.recentDiscussions'],
          ['team', Settings2, 'assistant.manageTeam'],
        ] as const
      ).map(([id, Icon, label]) => (
        <button
          key={id}
          type="button"
          className="assistant-activity-button text-xs"
          data-testid={`collaboration-exp-assistant-toolbar-${id}`}
          aria-expanded={panel === id}
          onClick={() => onPanelChange(panel === id ? null : id)}
        >
          <Icon size={15} aria-hidden="true" />
          {t(label)}
        </button>
      ))}
    </div>
  )
}
