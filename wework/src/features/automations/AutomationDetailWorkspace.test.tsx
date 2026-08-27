import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { emptyAutomationDraft, type AutomationDraft } from './automationDraft'
import { AutomationDetailWorkspace } from './AutomationDetailWorkspace'

function AutomationDetailHarness({
  devices = [],
}: {
  devices?: React.ComponentProps<typeof AutomationDetailWorkspace>['devices']
}) {
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    emptyAutomationDraft('local', 'local-device')
  )
  return (
    <AutomationDetailWorkspace
      draft={draft}
      automation={null}
      runs={[]}
      locale="zh-CN"
      devices={devices}
      projects={[]}
      models={[]}
      currentRuntimeTask={null}
      runtimeWork={null}
      localDeviceIds={['local-device']}
      saving={false}
      dirty
      running={false}
      onChange={(key, value) => setDraft(current => ({ ...current, [key]: value }))}
      onModelChange={vi.fn()}
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

  test('labels only the device matching the current executor identity as this computer', async () => {
    const user = userEvent.setup()
    render(
      <AutomationDetailHarness
        devices={[
          {
            id: 1,
            device_id: 'registered-current-device',
            app_device_id: 'local-device',
            name: '公司发的MicroLee用的MacbookPro',
            status: 'online',
            is_default: true,
            device_type: 'app',
            bind_shell: 'claudecode',
          },
          {
            id: 2,
            device_id: 'another-device',
            name: 'Local Executor',
            status: 'online',
            is_default: false,
            device_type: 'app',
            bind_shell: 'claudecode',
          },
        ]}
      />
    )

    await user.click(screen.getByTestId('automation-device-select'))

    expect(screen.getByTestId('automation-device-select-menu')).toHaveTextContent('此电脑')
    expect(screen.getByTestId('automation-device-select-menu')).toHaveTextContent('Local Executor')
  })
})
