import { useCallback, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { BranchPicker } from '@/components/common/branch-selector/BranchPicker'
const meta = { title: 'Business/BranchPicker', component: BranchPicker } satisfies Meta<
  typeof BranchPicker
>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ loading = false, failure = false, busy = false, empty = false }) {
  const [value, setValue] = useState('main')
  const attempt = useRef(0)
  const onListBranches = useCallback(async () => {
    if (loading) return new Promise<string[]>(() => {})
    if (failure && attempt.current++ === 0)
      throw new Error('Example directory failure: retry to recover')
    return empty ? [] : ['main', 'feature/component-library', 'fix/keyboard-navigation']
  }, [loading, failure, empty])
  return (
    <div className="max-w-lg space-y-3">
      <BranchPicker
        value={value}
        label={value}
        prefix="catalog-branch"
        triggerTestId="catalog-branch-trigger"
        accessibleLabel="Branch"
        onListBranches={onListBranches}
        onChoose={setValue}
        busy={busy}
      />
      <output>{value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Loading: Story = { render: () => <Example loading /> }
export const RetryDirectoryFailure: Story = { render: () => <Example failure /> }
export const DisabledBranches: Story = { render: () => <Example busy /> }
export const Empty: Story = { render: () => <Example empty /> }
