import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { IssueOwnerPicker } from '@wegent/collaboration/controls/entities'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Business/IssueOwnerPicker', component: IssueOwnerPicker } satisfies Meta<
  typeof IssueOwnerPicker
>
export default meta
type Story = StoryObj<Record<string, never>>
import { issueHomeOwners } from '../../../packages/collaboration/src/platform/issueHomeOwners'

function Example({ disabled = false, empty = false }) {
  const { i18n } = useTranslation()
  const translate = createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')
  const [value, setValue] = useState<string | null>(null)
  const owners = issueHomeOwners(
    'example',
    empty
      ? []
      : [{ id: 2, user_id: 2, user_name: 'Alex', email: 'alex@example.test', role: 'Developer' }],
    [],
    [],
    translate
  )
  return (
    <div className="space-y-4">
      <IssueOwnerPicker
        owners={owners}
        value={value}
        onChange={setValue}
        disabled={disabled}
        translate={translate}
        showLabel
      />
      <output>{value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const UnassignedOnly: Story = { render: () => <Example empty /> }
