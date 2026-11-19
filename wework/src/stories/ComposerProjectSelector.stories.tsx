import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ComposerProjectSelector } from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/ComposerProjectSelector',
  component: ComposerProjectSelector,
} satisfies Meta<typeof ComposerProjectSelector>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false, empty = false, long = false }) {
  const { t } = useTranslation('componentCatalog')
  const [value, onChange] = useState('local')
  return (
    <div className="max-w-sm space-y-3">
      <ComposerProjectSelector
        value={empty ? '' : value}
        options={
          empty
            ? []
            : [
                {
                  value: 'local',
                  label: long ? t('long') : t('localProject'),
                  description: t('localProject'),
                },
                { value: 'cloud', label: t('cloudProject'), description: t('cloudProject') },
                { value: 'disabled', label: t('disabled'), disabled: true },
              ]
        }
        onChange={onChange}
        label={t('project')}
        disabled={disabled}
        testId="catalog-composer-project"
      />
      <output>{empty ? '' : value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const Empty: Story = { render: () => <Example empty /> }
export const LongProjectName: Story = { render: () => <Example long /> }
