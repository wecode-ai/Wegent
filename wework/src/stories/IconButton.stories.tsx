import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconButton } from '@wegent/collaboration/controls'
import { Plus } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/IconButton', component: IconButton } satisfies Meta<
  typeof IconButton
>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false, pending = false, compact = false }) {
  const { t } = useTranslation('componentCatalog')
  const [count, setCount] = useState(0)
  return (
    <div className="flex items-center gap-3">
      <IconButton
        aria-label={t('add')}
        disabled={disabled}
        pending={pending}
        density={compact ? 'compact' : 'default'}
        onClick={() => setCount(c => c + 1)}
        data-testid="catalog-icon-action"
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
      </IconButton>
      <output>{count}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const Pending: Story = { render: () => <Example pending /> }
export const Compact: Story = { render: () => <Example compact /> }
