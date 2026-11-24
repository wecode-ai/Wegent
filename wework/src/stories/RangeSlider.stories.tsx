import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { RangeSlider } from '@wegent/collaboration/controls/RangeSlider'
const meta = {
  title: 'Controls/RangeSlider',
  component: RangeSlider,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof RangeSlider>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState(50)
  return (
    <div className="max-w-md">
      <RangeSlider
        testId="catalog-slider"
        label={t('selected')}
        value={value}
        max={100}
        onChange={setValue}
        disabled={disabled}
        valueText={String(value)}
      />
      <output aria-live="polite">{value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
