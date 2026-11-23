import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  GroupParticipantsEditor,
  type GroupCandidate,
} from '@wegent/collaboration/controls/entities'
import type { CollaborationGroup } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/GroupParticipantsEditor',
  component: GroupParticipantsEditor,
} satisfies Meta<typeof GroupParticipantsEditor>
export default meta
type Story = StoryObj<Record<string, never>>
const candidates: GroupCandidate[] = [
  { value: 'human:2', kind: 'human', id: '2', name: 'Alex' },
  { value: 'agent:reviewer', kind: 'agent', id: 'reviewer', name: 'Example reviewer' },
]
function Example({ readOnly = false, empty = false }) {
  const { i18n } = useTranslation()
  const [leader, setLeader] = useState('human:2')
  const [members, setMembers] = useState<CollaborationGroup['members']>([])
  return (
    <div className="max-w-xl">
      <GroupParticipantsEditor
        candidates={empty ? [] : candidates}
        leader={empty ? '' : leader}
        members={members}
        locale={i18n.language === 'en' ? 'en' : 'zh-CN'}
        readOnly={readOnly}
        onLeaderChange={candidate => setLeader(candidate.value)}
        onMemberChange={(candidate, selected) =>
          setMembers(current =>
            selected
              ? [...current, { kind: candidate.kind, id: candidate.id, responsibility: '' }]
              : current.filter(
                  member => member.kind !== candidate.kind || member.id !== candidate.id
                )
          )
        }
        onResponsibilityChange={(candidate, responsibility) =>
          setMembers(current =>
            current.map(member =>
              member.kind === candidate.kind && member.id === candidate.id
                ? { ...member, responsibility }
                : member
            )
          )
        }
      />
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const ReadOnly: Story = { render: () => <Example readOnly /> }
export const Empty: Story = { render: () => <Example empty /> }
