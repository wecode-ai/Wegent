import { AutomationDetailWorkspace } from '@/features/automations/AutomationDetailWorkspace'
import { automationTaskSelectionFixture } from '@/stories/fixtures/automationTaskSelection'
import type { AutomationDraft } from '@/features/automations/automationDraft'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import '../../../../packages/collaboration/src/test/setup'
import { WeekdayMenu } from './MenuSelect'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

function SchedulingChoices() {
  const [days, setDays] = useState(['1'])
  const [singleDay, setSingleDay] = useState(['1'])
  return (
    <>
      <WeekdayMenu testId="contract-weekdays" value={days} onChange={setDays} />
      <WeekdayMenu testId="contract-weekday" value={singleDay} onChange={setSingleDay} single />
      <output data-testid="contract-days-result">{days.join(',')}</output>
      <output data-testid="contract-day-result">{singleDay.join(',')}</output>
    </>
  )
}

it('exposes scheduling choices and keeps the last weekday selected while keyboard radio selection commits and closes', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const find = (id: string) => document.querySelector<HTMLElement>('[data-testid="' + id + '"]')!
  const key = async (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    })
  try {
    await act(async () => root.render(<SchedulingChoices />))
    await act(async () => find('contract-weekdays').click())
    await vi.waitFor(() =>
      expect(find('contract-weekdays-option-1')?.getAttribute('role')).toBe('menuitemcheckbox')
    )
    expect(find('contract-weekdays-option-1').getAttribute('aria-checked')).toBe('true')
    await act(async () => find('contract-weekdays-option-1').click())
    expect(find('contract-days-result').textContent).toBe('1')
    expect(find('contract-weekdays-option-1').getAttribute('aria-checked')).toBe('true')
    await act(async () => find('contract-weekdays-option-2').click())
    expect(find('contract-days-result').textContent).toBe('1,2')
    expect(find('contract-weekdays-option-2').getAttribute('aria-checked')).toBe('true')
    expect(find('contract-weekdays').getAttribute('aria-expanded')).toBe('true')
    await key('Escape')
    await vi.waitFor(() =>
      expect(find('contract-weekdays').getAttribute('aria-expanded')).toBe('false')
    )
    await act(async () => find('contract-weekday').focus())
    await key('ArrowDown')
    await vi.waitFor(() =>
      expect(find('contract-weekday-option-1')?.getAttribute('role')).toBe('menuitemradio')
    )
    expect(find('contract-weekday-option-1').getAttribute('aria-checked')).toBe('true')
    await key('End')
    await key('Enter')
    await vi.waitFor(() => expect(find('contract-day-result').textContent).toBe('0'))
    expect(find('contract-weekday').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(find('contract-weekday'))
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

function ScheduledTaskChoices({ empty = false }: { empty?: boolean }) {
  const [fixture] = useState(() => automationTaskSelectionFixture(empty))
  const [draft, setDraft] = useState<AutomationDraft>(fixture.draft)
  return (
    <>
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
        onSave={() => {}}
        onRun={() => {}}
        onToggle={() => {}}
        onDelete={() => {}}
      />
      <output data-testid="contract-task-result">
        {JSON.stringify({
          address: draft.continuationAddress,
          deviceId: draft.deviceId,
          workspacePath: draft.workspacePath,
        })}
      </output>
    </>
  )
}

it('searches pinned task keys, rejects offline choices, updates the automation target and explains an empty list', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const find = (id: string) => document.querySelector<HTMLElement>('[data-testid="' + id + '"]')
  try {
    await act(async () => root.render(<ScheduledTaskChoices />))
    const trigger = find('automation-target-task-select')!
    await act(async () => trigger.click())
    await vi.waitFor(() =>
      expect(
        find('automation-target-task-select-option-offline:unavailable')?.getAttribute(
          'aria-disabled'
        )
      ).toBe('true')
    )
    await act(async () => find('automation-target-task-select-option-offline:unavailable')!.click())
    expect(JSON.parse(find('contract-task-result')!.textContent!).address).toBeNull()
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="automation-target-task-select-search"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'Pinned review'
      )
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(() =>
      expect(find('automation-target-task-select-option-offline:unavailable')).toBeNull()
    )
    await act(async () => find('automation-target-task-select-option-online:ready')!.click())
    expect(JSON.parse(find('contract-task-result')!.textContent!)).toMatchObject({
      address: { deviceId: 'online', taskId: 'ready', workspacePath: '/example/project' },
      deviceId: 'online',
      workspacePath: '/example/project',
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await act(async () => root.render(<ScheduledTaskChoices key="empty" empty />))
    await act(async () => find('automation-target-task-select')!.click())
    await vi.waitFor(() =>
      expect(find('automation-target-task-select-menu')?.textContent).toContain(
        '请先置顶一个可用设备上的任务，再使用已安排任务'
      )
    )
    expect(
      document.querySelectorAll('[data-testid^="automation-target-task-select-option-"]')
    ).toHaveLength(0)
    expect(JSON.parse(find('contract-task-result')!.textContent!).address).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
