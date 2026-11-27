import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  ProjectCollaboratorPicker,
  projectCreateLabels,
  type ProjectCreateResourceSetup,
} from '@wegent/collaboration/project-create'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/ProjectCollaboratorPicker',
  component: ProjectCollaboratorPicker,
  parameters: {
    docs: {
      description: {
        component:
          'People, agents and groups use the same search and option presentation. Excluded members cannot be added again; stale directory responses are discarded. / 人员、智能体与小组复用统一搜索；排除重复成员，丢弃过期搜索结果。',
      },
    },
  },
} satisfies Meta<typeof ProjectCollaboratorPicker>
export default meta
type Story = StoryObj<Record<string, never>>
const people = [
  { id: 2, user_name: 'Alex', email: 'alex@example.test' },
  { id: 3, user_name: 'Bo', email: 'bo@example.test' },
]
const agents: ProjectCreateResourceSetup['agents'] = [
  {
    id: 'reviewer',
    name: 'Example reviewer',
    owner_type: 'user',
    owner_id: '1',
    owner_name: 'Example owner',
    execution_environment_ids: [],
    status: 'available',
  },
]
const groups: ProjectCreateResourceSetup['groups'] = [
  {
    id: 'team',
    workspace_id: 'example',
    name: 'Example team',
    description: 'Example review team',
    owner_type: 'workspace',
    owner_id: 'example',
    leader: { kind: 'agent', id: 'reviewer', responsibility: '' },
    members: [],
    stages: [],
    coordination_mode: 'manager',
    version: 1,
    created_by_user_id: 1,
    created_at: '',
    updated_at: '',
  },
]
function Example({ empty = false, failure = false }: { empty?: boolean; failure?: boolean }) {
  const { i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const labels = projectCreateLabels[i18n.language === 'en' ? 'en' : 'zh-CN']
  const choose = (value: string) => {
    setSelected(current => [...current, value])
    setOpen(false)
  }
  return (
    <div className="max-w-lg space-y-4">
      <ProjectCollaboratorPicker
        labels={labels}
        open={open}
        onOpenChange={setOpen}
        people={empty ? [] : people}
        excludedIds={selected
          .filter(value => value.startsWith('user:'))
          .map(value => Number(value.slice(5)))}
        agents={empty ? [] : agents}
        groups={empty ? [] : groups}
        searchUsers={async query => {
          if (failure) throw new Error('Example directory failure')
          return people.filter(person =>
            person.user_name.toLowerCase().includes(query.toLowerCase())
          )
        }}
        onSelectPerson={person => choose(`user:${person.id}`)}
        onSelectAgent={id => choose(`agent:${id}`)}
        onSelectGroup={id => choose(`group:${id}`)}
      />
      <output aria-live="polite">{selected.join(', ')}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
export const DirectoryFailure: Story = { render: () => <Example failure /> }
