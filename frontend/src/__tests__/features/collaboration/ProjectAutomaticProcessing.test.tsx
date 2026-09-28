// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectAutomaticProcessing } from '@wegent/collaboration'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
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

const project = { id: 'project-1', access_role: 'Owner' } as CollaborationProject
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
    incomingHooks: { list: jest.fn().mockResolvedValue([]) },
  }
  return {
    api,
    view: (id = project.id) => (
      <ProjectAutomaticProcessing
        api={api as unknown as SharedWorkspaceApi}
        project={{ ...project, id }}
        members={[]}
        agents={agents}
        locale="zh-CN"
        translate={(_key, fallback) => fallback ?? _key}
      />
    ),
  }
}

describe('ProjectAutomaticProcessing loading', () => {
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
