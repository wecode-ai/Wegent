import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { TextField } from '@wegent/collaboration/controls/TextField'
const meta = {
  title: 'Controls/TextField',
  component: TextField,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof TextField>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({
  invalid = false,
  disabled = false,
  readOnly = false,
}: {
  invalid?: boolean
  disabled?: boolean
  readOnly?: boolean
}) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('Example')
  return (
    <label className="grid max-w-sm gap-2 text-sm">
      {t('name')}
      <TextField
        data-testid="catalog-field"
        value={value}
        onChange={event => setValue(event.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'catalog-field-error' : undefined}
      />
      {invalid && (
        <span id="catalog-field-error" role="alert" className="text-destructive">
          {t('failed')}
        </span>
      )}
    </label>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Invalid: Story = { render: () => <Example invalid /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const ReadOnly: Story = { render: () => <Example readOnly /> }
