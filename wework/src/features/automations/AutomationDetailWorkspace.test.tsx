import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { emptyAutomationDraft, type AutomationDraft } from './automationDraft'
import { AutomationDetailWorkspace } from './AutomationDetailWorkspace'

function AutomationDetailHarness() {
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    emptyAutomationDraft('local', 'local-device')
  )
  return (
    <AutomationDetailWorkspace
      draft={draft}
      automation={null}
      runs={[]}
      locale="zh-CN"
      devices={[]}
      projects={[]}
      models={[]}
      currentRuntimeTask={null}
      runtimeWork={null}
      localDeviceIds={['local-device']}
      saving={false}
      dirty
      running={false}
      onChange={(key, value) => setDraft(current => ({ ...current, [key]: value }))}
      onSourceChange={vi.fn()}
      onClose={vi.fn()}
      onSave={vi.fn()}
      onRun={vi.fn()}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
    />
  )
}

describe('AutomationDetailWorkspace', () => {
  test('enables the task instructions as a persistent goal', async () => {
    const user = userEvent.setup()
    render(<AutomationDetailHarness />)

    await user.click(screen.getByTestId('automation-goal-switch'))

    expect(screen.getByTestId('automation-goal-switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('将任务说明作为目标持续推进，直到目标完成')).toBeInTheDocument()
  })
})
