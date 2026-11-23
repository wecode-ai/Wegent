import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
const meta = {
  title: 'Controls/Checkbox',
  component: Checkbox,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof Checkbox>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ mixed = false, disabled = false }: { mixed?: boolean; disabled?: boolean }) {
  const { t } = useTranslation('componentCatalog')
  const [checked, setChecked] = useState<boolean | 'indeterminate'>(mixed ? 'indeterminate' : false)
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <Checkbox
        data-testid="catalog-checkbox"
        checked={checked}
        onCheckedChange={setChecked}
        disabled={disabled}
      />
      {t('selected')}
    </label>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Indeterminate: Story = { render: () => <Example mixed /> }
export const Disabled: Story = { render: () => <Example disabled /> }
