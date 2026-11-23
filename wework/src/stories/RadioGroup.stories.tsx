import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { RadioGroup, Radio } from '@wegent/collaboration/controls/RadioGroup'
import { useTranslation } from '@/hooks/useTranslation'

const meta = {
  title: 'Controls/RadioGroup',
  component: RadioGroup,
  parameters: {
    docs: {
      description: {
        component:
          'One mutually exclusive value with a single tab stop. Arrows skip unavailable options; Home/End preserve the project shortcut contract. / 单一互斥值；方向键跳过禁用选项，统一保留 Home/End 操作。',
      },
    },
  },
} satisfies Meta<typeof RadioGroup>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('first')
  return (
    <RadioGroup
      value={value}
      disabled={disabled}
      aria-label={t('selected')}
      onValueChange={next => {
        if (next) setValue(next)
      }}
      className="grid gap-2"
    >
      {[
        { value: 'first', label: t('name') },
        { value: 'second', label: t('title') },
        { value: 'unavailable', label: t('disabled'), disabled: true },
      ].map(option => (
        <label key={option.value} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <Radio
            value={option.value}
            disabled={option.disabled}
            data-testid={`catalog-radio-${option.value}`}
          />
          {option.label}
        </label>
      ))}
    </RadioGroup>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
