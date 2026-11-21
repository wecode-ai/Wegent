import { TextField } from '@wegent/collaboration/controls/TextField'
import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
const meta = {
  title: 'Controls/SelectField',
  component: SelectField,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof SelectField>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false, invalid = false }: { disabled?: boolean; invalid?: boolean }) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('first')
  return (
    <SelectField
      value={value}
      onChange={setValue}
      accessibleLabel={t('name')}
      testId="catalog-select"
      disabled={disabled}
      invalid={invalid}
      options={[
        { value: 'first', label: t('name') },
        { value: 'second', label: t('title'), description: t('description') },
        { value: 'disabled', label: t('disabled'), disabled: true },
      ]}
    />
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const Invalid: Story = { render: () => <Example invalid /> }

export const KeyboardSequence: Story = {
  render: () => (
    <div className="space-y-3">
      <TextField data-testid="catalog-before-select" aria-label="Before select" />
      <Example />
      <TextField data-testid="catalog-after-select" aria-label="After select" />
    </div>
  ),
}
