import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { Textarea } from '@wegent/collaboration/controls/Textarea'
const meta = {
  title: 'Controls/Textarea',
  component: Textarea,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof Textarea>
export default meta
type Story = StoryObj<Record<string, never>>
function Example() {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('')
  return (
    <label className="grid max-w-lg gap-2 text-sm">
      {t('description')}
      <Textarea
        aria-label={t('description')}
        data-testid="catalog-textarea"
        value={value}
        onChange={event => setValue(event.target.value)}
        placeholder={t('description')}
        rows={4}
      />
    </label>
  )
}
export const Default: Story = { render: () => <Example /> }
