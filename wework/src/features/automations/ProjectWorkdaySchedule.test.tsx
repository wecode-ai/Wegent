import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ProjectAutomaticProcessing } from '@wegent/collaboration/project-manage'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationRule,
  CollaborationProject,
} from '@wegent/collaboration'

function workdayRule(timezone: string): WorkspaceAutomationRule {
  return {
    id: 'workday',
    projectId: 'project',
    name: 'Daily report',
    prompt: 'Report',
    triggerType: 'schedule',
    eventType: null,
    eventConfig: {},
    cronExpression: '0 9 * * *',
    workdayOnly: true,
    timezone,
    executionDeviceId: null,
    targetKind: 'agent',
    targetId: 'agent',
    targetName: 'Agent',
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    version: 1,
    createdAt: '',
    updatedAt: '',
  }
}

it.each(['Asia/Shanghai', 'America/New_York'])(
  'preserves %s and Cron when editing or toggling the statutory workday rule',
  async timezone => {
    const user = userEvent.setup()
    let rule = workdayRule(timezone)
    const update = vi.fn(async (_projectId, _ruleId, input) => {
      rule = { ...rule, ...input, version: rule.version + 1 }
      return rule
    })
    const create = vi.fn(async (_projectId, input) => {
      rule = { ...rule, ...input, id: 'new-workday', version: 1 }
      return rule
    })
    const api = {
      automations: { list: vi.fn(async () => [rule]), update, create },
      projects: { listCollaborationGroups: vi.fn(async () => []) },
      agents: { list: vi.fn(async () => [{ id: 'agent', name: 'Agent' }]) },
      members: { list: vi.fn(async () => []) },
    } as unknown as SharedWorkspaceApi
    render(
      <ProjectAutomaticProcessing
        api={api}
        project={{ id: 'project', name: 'Project', access_role: 'Owner' } as CollaborationProject}
        members={[]}
        agents={[]}
        locale="zh-CN"
        translate={createCollaborationTranslator('zh-CN')}
      />
    )
    await user.click(await screen.findByTestId('automatic-processing-edit-workday'))
    const filter = screen.getByRole('checkbox', { name: '仅中国大陆法定工作日执行' })
    expect(filter).toBeChecked()
    expect(screen.getByText(timezone)).toBeVisible()
    expect(screen.getByTestId('automatic-processing-schedule-frequency')).toHaveValue('daily')
    await user.click(filter)
    await user.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'project',
        'workday',
        expect.objectContaining({
          version: 1,
          workdayOnly: false,
          cronExpression: '0 9 * * *',
          timezone,
          triggerType: 'schedule',
        })
      )
    )
    await waitFor(() =>
      expect(screen.queryByTestId('automatic-processing-form')).not.toBeInTheDocument()
    )
    await user.click(screen.getByTestId('automatic-processing-enabled-workday'))
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(
        'project',
        'workday',
        expect.objectContaining({
          version: 2,
          enabled: false,
          workdayOnly: false,
          timezone,
          cronExpression: '0 9 * * *',
        })
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('automatic-processing-enabled-workday')).toHaveAttribute(
        'aria-checked',
        'false'
      )
    )
    await user.click(screen.getByTestId('automatic-processing-edit-workday'))
    expect(screen.getByTestId('automatic-processing-workday-only')).not.toBeChecked()
    await user.click(screen.getByTestId('automatic-processing-workday-only'))
    await user.click(screen.getByTestId('automatic-processing-cancel'))
    await user.click(screen.getByTestId('automatic-processing-create'))
    await user.click(screen.getByTestId('automatic-processing-trigger-schedule'))
    expect(screen.getByTestId('automatic-processing-workday-only')).not.toBeChecked()
    expect(screen.getByText('Asia/Shanghai')).toBeVisible()
    await user.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({
          timezone: 'Asia/Shanghai',
          workdayOnly: false,
          cronExpression: '0 9 * * 1-5',
        })
      )
    )
  }
)

it('keeps the saved rule editor pending until its refreshed list can be reopened', async () => {
  const user = userEvent.setup()
  let rule = workdayRule('Asia/Shanghai')
  let publishRefresh!: (rules: WorkspaceAutomationRule[]) => void
  const refresh = new Promise<WorkspaceAutomationRule[]>(resolve => {
    publishRefresh = resolve
  })
  const list = vi.fn().mockResolvedValueOnce([rule]).mockReturnValueOnce(refresh)
  const update = vi.fn(async () => {
    rule = { ...rule, workdayOnly: false, version: rule.version + 1 }
    return rule
  })
  const api = {
    automations: { list, update },
    projects: { listCollaborationGroups: vi.fn(async () => []) },
    agents: { list: vi.fn(async () => [{ id: 'agent', name: 'Agent' }]) },
    members: { list: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
  render(
    <ProjectAutomaticProcessing
      api={api}
      project={{ id: 'project', name: 'Project', access_role: 'Owner' } as CollaborationProject}
      members={[]}
      agents={[]}
      locale="zh-CN"
      translate={createCollaborationTranslator('zh-CN')}
    />
  )
  await user.click(await screen.findByTestId('automatic-processing-edit-workday'))
  await user.click(screen.getByTestId('automatic-processing-workday-only'))
  await user.click(screen.getByTestId('automatic-processing-save'))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('automatic-processing-form')).toBeVisible()
  expect(screen.getByTestId('automatic-processing-save')).toBeDisabled()
  await act(async () => publishRefresh([rule]))
  await waitFor(() =>
    expect(screen.queryByTestId('automatic-processing-form')).not.toBeInTheDocument()
  )
  await user.click(screen.getByTestId('automatic-processing-edit-workday'))
  expect(screen.getByTestId('automatic-processing-workday-only')).not.toBeChecked()
})

it('keeps another project draft open when the previous project save refresh finishes', async () => {
  const user = userEvent.setup()
  const rule = workdayRule('Asia/Shanghai')
  let finishRefresh!: (rules: WorkspaceAutomationRule[]) => void
  const refresh = new Promise<WorkspaceAutomationRule[]>(resolve => {
    finishRefresh = resolve
  })
  const list = vi
    .fn()
    .mockResolvedValueOnce([rule])
    .mockReturnValueOnce(refresh)
    .mockResolvedValue([])
  const api = {
    automations: { list, update: vi.fn(async () => rule) },
    projects: { listCollaborationGroups: vi.fn(async () => []) },
    agents: { list: vi.fn(async () => [{ id: 'agent', name: 'Agent' }]) },
    members: { list: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
  const panel = (id: string) => (
    <ProjectAutomaticProcessing
      api={api}
      project={{ id, name: id, access_role: 'Owner' } as CollaborationProject}
      members={[]}
      agents={[]}
      locale="zh-CN"
      translate={createCollaborationTranslator('zh-CN')}
    />
  )
  const view = render(panel('project'))
  await user.click(await screen.findByTestId('automatic-processing-edit-workday'))
  await user.click(screen.getByTestId('automatic-processing-save'))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  view.rerender(panel('other-project'))
  await user.click(await screen.findByTestId('automatic-processing-create'))
  const form = screen.getByTestId('automatic-processing-form')
  expect(form).toBeVisible()
  await act(async () => finishRefresh([rule]))
  expect(form).toBeInTheDocument()
  expect(screen.getByTestId('automatic-processing-form')).toBeVisible()
})
