import { useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createPersonalIssuesApi } from '@/api/personalIssues'
import { IssueParticipantPicker } from '@/features/todo/IssueParticipantPicker'
import type { IssueParticipant } from '@/features/todo/issueParticipants'
const meta = {
  title: 'Business/IssueParticipantPicker',
  component: IssueParticipantPicker,
} satisfies Meta<typeof IssueParticipantPicker>
export default meta
type Story = StoryObj<Record<string, never>>
const unsupported = async (): Promise<never> => {
  throw new Error('This preview only supports directory search')
}
function Example({ disabled = false, empty = false, failure = false }) {
  const [assigneeKey, setAssigneeKey] = useState('human:1')
  const [selected, onChange] = useState<IssueParticipant[]>([
    { id: 1, kind: 'human', key: 'human:1', name: 'Me' },
  ])
  const api = useMemo(
    () => ({
      ...createPersonalIssuesApi({
        get: unsupported,
        getBlob: unsupported,
        post: unsupported,
        put: unsupported,
        patch: unsupported,
        delete: unsupported,
      }),
      searchUsers: async (query: string) => {
        if (failure) throw new Error('Example directory failure')
        return {
          users: empty
            ? []
            : [
                { id: 2, user_name: 'Alex' },
                { id: 3, user_name: 'Bo' },
              ].filter(user => user.user_name.toLowerCase().includes(query.toLowerCase())),
        }
      },
    }),
    [empty, failure]
  )
  return (
    <div className="max-w-lg">
      <IssueParticipantPicker
        api={api}
        selected={selected}
        onChange={onChange}
        disabled={disabled}
        userId={1}
        ownerId={1}
        assigneeKey={assigneeKey}
        onAssign={person => setAssigneeKey(person?.key ?? '')}
      />
      <output>{selected.map(item => item.name).join(', ')}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const Empty: Story = { render: () => <Example empty /> }
export const DirectoryFailure: Story = { render: () => <Example failure /> }
