import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { SegmentedControl } from '@wegent/collaboration/controls/SegmentedControl'
const meta = {
  title: 'Controls/SegmentedControl',
  component: SegmentedControl,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof SegmentedControl>
export default meta
type Story = StoryObj<Record<string, never>>
function Example() {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('first')
  return (
    <SegmentedControl
      label={t('name')}
      value={value}
      onChange={setValue}
      options={[
        { value: 'first', label: t('name'), testId: 'catalog-segment-first' },
        { value: 'second', label: t('title'), testId: 'catalog-segment-second' },
        {
          value: 'disabled',
          label: t('disabled'),
          testId: 'catalog-segment-disabled',
          disabled: true,
        },
      ]}
    />
  )
}
export const Default: Story = { render: () => <Example /> }
