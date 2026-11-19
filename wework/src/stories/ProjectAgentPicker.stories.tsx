import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProjectAgentPicker } from '@wegent/collaboration/controls/entities'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Business/ProjectAgentPicker', component: ProjectAgentPicker } satisfies Meta<
  typeof ProjectAgentPicker
>
export default meta
type Story = StoryObj<Record<string, never>>

const agents = [
  {
    id: 'reviewer',
    team_id: 1,
    name: 'Example reviewer',
    owner_type: 'user' as const,
    owner_id: '1',
    owner_name: 'Example owner',
    execution_environment_ids: [],
    status: 'available' as const,
  },
]
function Example({ loading = false, failure = false, empty = false, busy = false }) {
  const { i18n } = useTranslation()
  const translate = createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')
  const [selectedId, onSelect] = useState('')
  const [message, setMessage] = useState('')
  return (
    <div className="max-w-lg">
      <ProjectAgentPicker
        agents={empty ? [] : agents}
        addedTeamIds={new Set()}
        selectedId={selectedId}
        loading={loading}
        loadError={failure ? 'Example directory failure' : null}
        error={null}
        busy={busy}
        scope="project"
        translate={translate}
        onSelect={onSelect}
        onRetry={() => setMessage('Retry requested')}
        onClose={() => setMessage('Closed')}
        onAdd={() => setMessage('Added: ' + selectedId)}
      />
      <output aria-live="polite">{message}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Loading: Story = { render: () => <Example loading /> }
export const Empty: Story = { render: () => <Example empty /> }
export const DirectoryFailure: Story = { render: () => <Example failure /> }
export const Saving: Story = { render: () => <Example busy /> }
