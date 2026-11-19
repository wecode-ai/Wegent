import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProgressBar, ProgressRing } from '@wegent/collaboration/controls'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/Progress', component: ProgressBar } satisfies Meta<
  typeof ProgressBar
>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ value }: { value: number | null }) {
  const { t } = useTranslation('componentCatalog')
  return (
    <div className="max-w-md space-y-3">
      <ProgressBar value={value} label={t('progress')} testId="catalog-progress-bar" />
      <ProgressRing value={value} label={t('progress')} testId="catalog-progress-ring" />
      <output>{value === null ? t('loading') : value + '%'}</output>
    </div>
  )
}
export const InProgress: Story = { render: () => <Example value={42} /> }
export const Indeterminate: Story = { render: () => <Example value={null} /> }
export const Empty: Story = { render: () => <Example value={0} /> }
export const Complete: Story = { render: () => <Example value={100} /> }
