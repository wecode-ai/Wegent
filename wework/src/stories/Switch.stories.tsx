import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { Switch } from '@wegent/collaboration/controls/Switch'
const meta = {
  title: 'Controls/Switch',
  component: Switch,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof Switch>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('componentCatalog')
  const [checked, setChecked] = useState(false)
  return (
    <label className="inline-flex items-center gap-3 text-sm">
      {t('selected')}
      <Switch
        aria-label={t('selected')}
        data-testid="catalog-switch"
        checked={checked}
        onCheckedChange={setChecked}
        disabled={disabled}
      />
    </label>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const Uncontrolled: Story = {
  render: () => (
    <Switch
      defaultChecked
      data-testid="catalog-switch-uncontrolled"
      aria-label="Uncontrolled example"
    />
  ),
}
