import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { BoardViewTagPicker } from '../../../packages/collaboration/src/project-board/BoardViewTagPicker'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Business/BoardViewTagPicker', component: BoardViewTagPicker } satisfies Meta<
  typeof BoardViewTagPicker
>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({ disabled = false, empty = false }) {
  const { i18n } = useTranslation()
  const translate = createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')
  const [value, onChange] = useState('')
  return (
    <div className="max-w-lg space-y-4">
      <BoardViewTagPicker
        value={value}
        tags={empty ? [] : ['Design', 'Engineering', 'Release']}
        usedTags={['Release']}
        disabled={disabled}
        testId="catalog-board-tag"
        portalContainer={null}
        translate={translate}
        onChange={onChange}
      />
      <output>{value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const CreateFirstTag: Story = { render: () => <Example empty /> }
