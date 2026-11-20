import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProjectBoardGroupPicker } from '@wegent/collaboration/controls/entities'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/ProjectBoardGroupPicker',
  component: ProjectBoardGroupPicker,
} satisfies Meta<typeof ProjectBoardGroupPicker>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({ empty = false }) {
  const [value, setValue] = useState('status')
  const { t } = useTranslation('componentCatalog')
  return (
    <ProjectBoardGroupPicker
      fields={
        empty
          ? []
          : [
              { id: 'status', name: t('status'), type: 'Select' },
              { id: 'owner', name: t('person'), type: 'Person' },
              { id: 'project', name: t('project'), type: 'Text' },
            ]
      }
      value={value}
      onChange={setValue}
      chooseLabel={t('project')}
      searchPlaceholder={t('search')}
      emptyLabel={t('empty')}
    />
  )
}
export const Default: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
