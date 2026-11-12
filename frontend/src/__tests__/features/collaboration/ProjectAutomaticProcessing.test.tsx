// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createCollaborationTranslator, ProjectAutomaticProcessing } from '@wegent/collaboration'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceAutomationInput,
  WorkspaceAutomationRule,
} from '@wegent/collaboration'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const project = {
  id: 'project-1',
  access_role: 'Owner',
  board_config: {
    group_by: 'status',
    processing_start_status_id: 'pending',
    statuses: [
      { id: 'inbox', name: '收集箱', color: 'gray' },
      { id: 'pending', name: '待开始', color: 'blue' },
      { id: 'in_progress', name: '进行中', color: 'orange' },
      { id: 'in_review', name: '待确认', color: 'purple' },
      { id: 'completed', name: '已完成', color: 'green' },
      { id: 'custom-review', name: '安全评审', color: 'gray' },
    ],
  },
} as CollaborationProject
const agents = [{ id: 'agent-1', name: '处理智能体' }]
const rule = {
  id: 'rule-1',
  name: '自动分配',
  version: 1,
  targetKind: 'agent',
  targetId: 'agent-1',
} as WorkspaceAutomationRule

function fixture() {
  const api = {
    automations: {
      list: jest.fn().mockResolvedValue([rule]),
      create: jest.fn().mockResolvedValue(rule),
      update: jest.fn().mockResolvedValue(rule),
      remove: jest.fn().mockResolvedValue(undefined),
    },
    projects: { listCollaborationGroups: jest.fn().mockResolvedValue([]) },
    agents: { list: jest.fn().mockResolvedValue(agents) },
    members: { list: jest.fn().mockResolvedValue([]) },
    incomingHooks: { list: jest.fn().mockResolvedValue([]) },
  }
  return {
    api,
    view: (id = project.id, locale: 'zh-CN' | 'en' = 'zh-CN') => (
      <ProjectAutomaticProcessing
        api={api as unknown as SharedWorkspaceApi}
        project={{ ...project, id }}
        members={[]}
        agents={agents}
        locale={locale}
        translate={createCollaborationTranslator(locale)}
      />
    ),
  }
}

describe('ProjectAutomaticProcessing loading', () => {
  it('loads members when opened directly and waits before choosing the default target', async () => {
    const { api, view } = fixture()
    const members = deferred<Array<{ user_id: number; user_name: string }>>()
    api.agents.list.mockResolvedValue([])
    api.members.list.mockReturnValue(members.promise)
    render(view())
    expect(await screen.findByText('自动分配')).toBeInTheDocument()
    expect(screen.getByTestId('automatic-processing-create')).toBeDisabled()
    await act(async () => members.resolve([{ user_id: 7, user_name: '项目成员' }]))
    expect(api.members.list).toHaveBeenCalledWith(project.id)
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    expect(screen.getByTestId('automatic-processing-target-kind-human')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ targetKind: 'human', targetId: '7' })
      )
    )
  })

  it('reports a member catalog failure without replacing the rules or creating an empty target', async () => {
    const { api, view } = fixture()
    api.members.list.mockRejectedValue(new Error('成员加载失败'))
    render(view())
    expect(await screen.findByText('自动分配')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('成员加载失败')
    expect(screen.getByTestId('automatic-processing-create')).toBeDisabled()
    expect(api.automations.create).not.toHaveBeenCalled()
  })

  it('shows rules without waiting for target catalogs or loading incoming hooks', async () => {
    const { api, view } = fixture()
    api.projects.listCollaborationGroups.mockReturnValue(new Promise(() => {}))
    api.agents.list.mockReturnValue(new Promise(() => {}))
    render(view())
    expect(await screen.findByText('自动分配')).toBeInTheDocument()
    expect(screen.queryByTestId('automatic-processing-loading')).not.toBeInTheDocument()
    expect(api.incomingHooks.list).not.toHaveBeenCalled()
  })

  it('does not reload when a parent supplies a new translation callback', async () => {
    const { api, view } = fixture()
    const mounted = render(view())
    await screen.findByText('自动分配')
    mounted.rerender(view())
    await act(async () => {})
    expect(api.automations.list).toHaveBeenCalledTimes(1)
    expect(api.agents.list).toHaveBeenCalledTimes(1)
    expect(api.projects.listCollaborationGroups).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous rules visible on reopen and shows refreshed results', async () => {
    const { api, view } = fixture()
    const mounted = render(view())
    await screen.findByText('自动分配')
    mounted.unmount()
    const refresh = deferred<WorkspaceAutomationRule[]>()
    api.automations.list.mockReturnValue(refresh.promise)
    render(view())
    expect(screen.getByText('自动分配')).toBeInTheDocument()
    expect(screen.queryByTestId('automatic-processing-loading')).not.toBeInTheDocument()
    await act(async () => refresh.resolve([{ ...rule, name: '更新后的规则' }]))
    expect(screen.getByText('更新后的规则')).toBeInTheDocument()
    expect(screen.queryByText('自动分配')).not.toBeInTheDocument()
    expect(api.automations.list).toHaveBeenCalledTimes(2)
  })

  it('preserves the rules and reports a failed background refresh', async () => {
    const { api, view } = fixture()
    const mounted = render(view())
    await screen.findByText('自动分配')
    mounted.unmount()
    api.automations.list.mockRejectedValue(new Error('刷新失败'))
    render(view())
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByText('自动分配')).toBeInTheDocument()
  })

  it('isolates projects and ignores a late response from the previous project', async () => {
    const { api, view } = fixture()
    const first = deferred<WorkspaceAutomationRule[]>()
    api.automations.list.mockReturnValueOnce(first.promise)
    const mounted = render(view())
    mounted.rerender(view('project-2'))
    await screen.findByText('自动分配')
    await act(async () => first.resolve([{ ...rule, name: '旧项目规则' }]))
    expect(screen.queryByText('旧项目规则')).not.toBeInTheDocument()
    expect(api.automations.list).toHaveBeenLastCalledWith('project-2')
    const next = deferred<WorkspaceAutomationRule[]>()
    api.automations.list.mockReturnValue(next.promise)
    mounted.rerender(view('project-3'))
    expect(screen.queryByText('自动分配')).not.toBeInTheDocument()
    expect(screen.getByTestId('automatic-processing-loading')).toBeInTheDocument()
    await act(async () => {})
  })

  it('does not share cached rules across API sessions', async () => {
    const first = fixture()
    const mounted = render(first.view())
    await screen.findByText('自动分配')
    mounted.unmount()
    const second = fixture()
    second.api.automations.list.mockReturnValue(new Promise(() => {}))
    render(second.view())
    expect(screen.queryByText('自动分配')).not.toBeInTheDocument()
    expect(screen.getByTestId('automatic-processing-loading')).toBeInTheDocument()
    await act(async () => {})
  })

  it('loads external sources only on demand and surfaces failures with a retry on re-entry', async () => {
    const { api, view } = fixture()
    const hooks = deferred<unknown[]>()
    api.incomingHooks.list.mockReturnValueOnce(hooks.promise)
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    expect(api.incomingHooks.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-external'))
    expect(screen.getByTestId('automatic-processing-hook')).toBeDisabled()
    expect(screen.getByTestId('automatic-processing-save')).toBeDisabled()
    await act(async () => hooks.reject(new Error('接入服务不可用')))
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('接入服务不可用')
    expect(screen.getByText('自动分配')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-created'))
    api.incomingHooks.list.mockResolvedValue([
      { id: 'hook-1', name: 'GitHub', sourceType: 'github' },
    ])
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-external'))
    await waitFor(() =>
      expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('hook-1')
    )
    expect(screen.getByTestId('automatic-processing-save')).toBeEnabled()
    expect(api.incomingHooks.list).toHaveBeenCalledTimes(2)
  })

  it('refreshes after deletion without hiding the list and caches the updated result', async () => {
    const { api, view } = fixture()
    const mounted = render(view())
    await screen.findByText('自动分配')
    const refresh = deferred<WorkspaceAutomationRule[]>()
    api.automations.list.mockReturnValueOnce(refresh.promise)
    fireEvent.click(screen.getByTestId('automatic-processing-delete-rule-1'))
    await waitFor(() => expect(api.automations.list).toHaveBeenCalledTimes(2))
    expect(screen.getByText('自动分配')).toBeInTheDocument()
    expect(screen.queryByTestId('automatic-processing-loading')).not.toBeInTheDocument()
    await act(async () => refresh.resolve([]))
    expect(screen.getByText('暂无自动处理规则')).toBeInTheDocument()
    mounted.unmount()
    api.automations.list.mockReturnValue(new Promise(() => {}))
    render(view())
    expect(screen.getByText('暂无自动处理规则')).toBeInTheDocument()
    await act(async () => {})
  })
})

describe('ProjectAutomaticProcessing status triggers', () => {
  it('requires a status and saves a selected custom board status', async () => {
    const { api, view } = fixture()
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-status_changed'))
    expect(screen.getByTestId('automatic-processing-save')).toBeDisabled()
    expect(screen.getByRole('option', { name: '安全评审' })).toHaveValue('custom-review')
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'custom-review' } })
    expect(screen.getByTestId('automatic-processing-preview')).toHaveTextContent(
      '进入指定状态后 · 安全评审'
    )
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          name: '进入指定状态后 · 安全评审 → 处理智能体',
          eventType: 'task.status_changed',
          eventConfig: {
            executionTarget: 'existing_issue',
            transition: 'any',
            statuses: ['custom-review'],
          },
        })
      )
    )
    expect(api.incomingHooks.list).not.toHaveBeenCalled()
  })

  it('reopens a saved status rule and persists a changed target status', async () => {
    const { api, view } = fixture()
    api.automations.list.mockResolvedValue([
      {
        ...rule,
        eventType: 'task.status_changed',
        eventConfig: { transition: 'any', statuses: ['in_review'] },
      },
    ])
    render(view())
    await screen.findByText('自动分配')
    expect(screen.getByTestId('automatic-processing-rule-rule-1')).toHaveTextContent(
      '进入指定状态后 · 待确认'
    )
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-trigger-status_changed')).toBeChecked()
    expect(screen.getByTestId('automatic-processing-status')).toHaveValue('in_review')
    fireEvent.change(screen.getByTestId('automatic-processing-status'), {
      target: { value: 'completed' },
    })
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.update).toHaveBeenCalledWith(
        project.id,
        rule.id,
        expect.objectContaining({
          version: rule.version,
          eventType: 'task.status_changed',
          eventConfig: {
            executionTarget: 'existing_issue',
            transition: 'any',
            statuses: ['completed'],
          },
        })
      )
    )
  })

  it.each([
    { transition: 'any', statuses: ['custom-review'] },
    { transition: 'any', statuses: ['in_review', 'custom-review'] },
    { transition: 'entered_processing' },
  ])('preserves status conditions when toggling $transition rules', async eventConfig => {
    const { api, view } = fixture()
    api.automations.list.mockResolvedValue([
      { ...rule, enabled: true, eventType: 'task.status_changed', eventConfig },
    ])
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-enabled-rule-1'))
    await waitFor(() =>
      expect(api.automations.update).toHaveBeenCalledWith(
        project.id,
        rule.id,
        expect.objectContaining({
          eventType: 'task.status_changed',
          eventConfig: { ...eventConfig, executionTarget: 'existing_issue' },
          enabled: false,
        })
      )
    )
  })

  it('preserves all saved target statuses until the selection is changed', async () => {
    const { api, view } = fixture()
    api.automations.list.mockResolvedValue([
      {
        ...rule,
        eventType: 'task.status_changed',
        eventConfig: { transition: 'any', statuses: ['in_review', 'custom-review'] },
      },
    ])
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-preview')).toHaveTextContent(
      '进入指定状态后 · 待确认、安全评审'
    )
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.update).toHaveBeenCalledWith(
        project.id,
        rule.id,
        expect.objectContaining({
          eventConfig: {
            executionTarget: 'existing_issue',
            transition: 'any',
            statuses: ['in_review', 'custom-review'],
          },
        })
      )
    )
  })

  it('keeps the processing-phase condition when editing an existing rule', async () => {
    const { api, view } = fixture()
    api.automations.list.mockResolvedValue([
      {
        ...rule,
        eventType: 'task.status_changed',
        eventConfig: { transition: 'entered_processing' },
      },
    ])
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-status')).toHaveValue('__entered_processing__')
    expect(screen.getByTestId('automatic-processing-preview')).toHaveTextContent('进入处理阶段后')
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.update).toHaveBeenCalledWith(
        project.id,
        rule.id,
        expect.objectContaining({
          eventType: 'task.status_changed',
          eventConfig: { executionTarget: 'existing_issue', transition: 'entered_processing' },
        })
      )
    )
  })

  it('removes status conditions when switching to a tag trigger', async () => {
    const { api, view } = fixture()
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-status_changed'))
    fireEvent.change(screen.getByTestId('automatic-processing-status'), {
      target: { value: 'completed' },
    })
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-tag_added'))
    fireEvent.change(screen.getByTestId('automatic-processing-tag'), {
      target: { value: 'review' },
    })
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          eventType: 'task.tag_added',
          eventConfig: { executionTarget: 'existing_issue', tags: ['review'] },
        })
      )
    )
  })

  it('requires a valid replacement when the configured status was removed', async () => {
    const { api, view } = fixture()
    api.automations.list.mockResolvedValue([
      {
        ...rule,
        eventType: 'task.status_changed',
        eventConfig: { transition: 'any', statuses: ['removed-status'] },
      },
    ])
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-save')).toBeDisabled()
    fireEvent.change(screen.getByTestId('automatic-processing-status'), {
      target: { value: 'custom-review' },
    })
    expect(screen.getByTestId('automatic-processing-save')).toBeEnabled()
  })

  it('localizes the status trigger and selector in English', async () => {
    const { view } = fixture()
    render(view(project.id, 'en'))
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.click(screen.getByTestId('automatic-processing-trigger-status_changed'))
    expect(screen.getByText('Status reached')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Select a status' })).toBeInTheDocument()
  })
})

describe('ProjectAutomaticProcessing prompts', () => {
  const prompt = '  请先分析 Issue 的需求。\n再用日本語、English 输出结果 ✅\n保留原文空白。  '
  const defaultPrompt = '按照目标职责和 Issue 内容完成处理，并记录清晰的执行结果。'

  it.each(['created', 'tag_added', 'status_changed', 'external', 'schedule'])(
    'saves the same multiline prompt for the %s trigger',
    async trigger => {
      const { api, view } = fixture()
      api.incomingHooks.list.mockResolvedValue([
        { id: 'hook-1', name: 'GitHub', sourceType: 'github' },
      ])
      render(view())
      await screen.findByText('自动分配')
      fireEvent.click(screen.getByTestId('automatic-processing-create'))
      const field = screen.getByLabelText('提示词（可选）')
      expect(field).toHaveValue('')
      expect(field).toHaveAccessibleDescription(
        '触发时发送给 AI，用于处理当前事项；留空按目标职责处理。'
      )
      fireEvent.change(field, { target: { value: prompt } })
      fireEvent.click(screen.getByTestId(`automatic-processing-trigger-${trigger}`))
      if (trigger === 'tag_added') {
        fireEvent.change(screen.getByTestId('automatic-processing-tag'), {
          target: { value: 'review' },
        })
      } else if (trigger === 'status_changed') {
        fireEvent.change(screen.getByTestId('automatic-processing-status'), {
          target: { value: 'custom-review' },
        })
      } else if (trigger === 'external') {
        await waitFor(() =>
          expect(screen.getByTestId('automatic-processing-hook')).toHaveValue('hook-1')
        )
      }
      expect(field).toHaveValue(prompt)
      expect(screen.getByTestId('automatic-processing-save')).toBeEnabled()
      fireEvent.click(screen.getByTestId('automatic-processing-save'))
      await waitFor(() =>
        expect(api.automations.create).toHaveBeenCalledWith(
          project.id,
          expect.objectContaining({ prompt })
        )
      )
    }
  )

  it('preserves the prompt through editing, API reloads and both switch directions', async () => {
    const { api, view } = fixture()
    let saved: WorkspaceAutomationRule = {
      ...rule,
      prompt: defaultPrompt,
      enabled: true,
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { executionTarget: 'existing_issue' },
    }
    api.automations.list.mockImplementation(async () => [saved])
    api.automations.update.mockImplementation(
      async (_projectId: string, _ruleId: string, input: WorkspaceAutomationInput) => {
        saved = { ...saved, ...input, version: saved.version + 1 }
        return saved
      }
    )
    const mounted = render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-prompt')).toHaveValue(defaultPrompt)
    fireEvent.change(screen.getByTestId('automatic-processing-prompt'), {
      target: { value: prompt },
    })
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.automations.update).toHaveBeenLastCalledWith(
      project.id,
      rule.id,
      expect.objectContaining({ prompt })
    )
    mounted.unmount()
    render(view())
    await waitFor(() => expect(api.automations.list).toHaveBeenCalledTimes(3))
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-prompt')).toHaveValue(prompt)
    fireEvent.click(screen.getByTestId('automatic-processing-cancel'))
    for (const enabled of [false, true]) {
      const toggle = screen.getByTestId('automatic-processing-enabled-rule-1')
      fireEvent.click(toggle)
      await waitFor(() => {
        expect(toggle).toHaveAttribute('aria-checked', String(enabled))
        expect(toggle).toBeEnabled()
      })
      expect(api.automations.update).toHaveBeenLastCalledWith(
        project.id,
        rule.id,
        expect.objectContaining({ prompt, enabled })
      )
    }
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-prompt')).toHaveValue(prompt)
  })

  it.each(['', ' \n\t '])('resets a cleared prompt %j to the default instruction', async empty => {
    const { api, view } = fixture()
    api.automations.list.mockResolvedValue([
      { ...rule, prompt, triggerType: 'event', eventType: 'task.created' },
    ])
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-edit-rule-1'))
    expect(screen.getByTestId('automatic-processing-prompt')).toHaveValue(prompt)
    fireEvent.change(screen.getByTestId('automatic-processing-prompt'), {
      target: { value: empty },
    })
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.update).toHaveBeenCalledWith(
        project.id,
        rule.id,
        expect.objectContaining({ prompt: defaultPrompt })
      )
    )
  })

  it('uses the existing default instruction when a new prompt is left empty', async () => {
    const { api, view } = fixture()
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ prompt: defaultPrompt })
      )
    )
  })

  it('retains the prompt when changing to a human target', async () => {
    const { api, view } = fixture()
    api.members.list.mockResolvedValue([{ user_id: 7, user_name: '项目成员' }])
    render(view())
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.change(screen.getByTestId('automatic-processing-prompt'), {
      target: { value: prompt },
    })
    fireEvent.click(screen.getByTestId('automatic-processing-target-kind-human'))
    expect(screen.getByTestId('automatic-processing-prompt')).toHaveValue(prompt)
    fireEvent.click(screen.getByTestId('automatic-processing-save'))
    await waitFor(() =>
      expect(api.automations.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ prompt, targetKind: 'human', targetId: '7' })
      )
    )
  })

  it('localizes the prompt label and description in English', async () => {
    const { view } = fixture()
    render(view(project.id, 'en'))
    await screen.findByText('自动分配')
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    expect(screen.getByLabelText('Prompt (optional)')).toHaveAccessibleDescription(
      "Sent to AI when triggered to work on the current Thread. Leave blank to use the target's responsibilities."
    )
  })
})
