import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AutomationDraft } from '@/features/automations/automationDraft'
import { AutomationDetailWorkspace } from '@/features/automations/AutomationDetailWorkspace'
import { automationTaskSelectionFixture } from './fixtures/automationTaskSelection'

const meta = {
  title: 'Business/AutomationTaskSelection',
  component: AutomationDetailWorkspace,
  parameters: {
    docs: {
      description: {
        component:
          'The production automation workspace searches pinned tasks and keeps task keys stable. Offline devices remain visible and disabled; the empty state explains how to pin an available task. / 实际自动化工作区使用任务 key 选择已固定任务；离线任务可见但不可选，空态说明如何准备可用任务。',
      },
    },
  },
} satisfies Meta<typeof AutomationDetailWorkspace>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ empty = false }: { empty?: boolean }) {
  const [fixture] = useState(() => automationTaskSelectionFixture(empty))
  const [draft, setDraft] = useState<AutomationDraft>(fixture.draft)
  const [saved, setSaved] = useState('')
  return (
    <div className="flex h-[720px] w-full flex-col">
      <AutomationDetailWorkspace
        {...fixture}
        draft={draft}
        automation={null}
        runs={[]}
        locale="en"
        projects={[]}
        models={[]}
        currentRuntimeTask={null}
        localDeviceIds={['online']}
        cloudAvailable={false}
        saving={false}
        dirty
        running={false}
        onChange={(key, value) => setDraft(current => ({ ...current, [key]: value }))}
        onModelChange={() => {}}
        onSourceChange={() => {}}
        onClose={() => {}}
        onSave={() => setSaved(draft.continuationAddress?.taskId ?? '')}
        onRun={() => {}}
        onToggle={() => {}}
        onDelete={() => {}}
      />
      <output role="status" data-testid="catalog-automation-task-result">
        {JSON.stringify({ selected: draft.continuationAddress, saved })}
      </output>
    </div>
  )
}
export const PinnedTasks: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
