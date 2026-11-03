import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInExecutorApi, StandInMemory } from '@/api/standIn'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import '@/i18n'
import { StandInMemoryPanel } from './StandInMemoryPanel'

function fixture(projects: CollaborationProject[] = []) {
  const row: StandInMemory = {
    id: 'memory-1',
    content: '回复简洁',
    scope: { kind: 'personal' },
    version: 2,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  }
  const api = {
    memories: vi.fn(async () => [row]),
    saveMemory: vi.fn(async (_user, _device, memory) => ({ ...row, ...memory, version: 3 })),
    deleteMemory: vi.fn(async () => {}),
  }
  const onClose = vi.fn()
  const settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 1,
    roles: [{ ...newStandInRole('mac', 'review'), name: '评审角色' }],
  }
  return {
    api,
    row,
    onClose,
    settings,
    render: () =>
      render(
        <StandInMemoryPanel
          api={api as unknown as StandInExecutorApi}
          settings={settings}
          projects={projects}
          onClose={onClose}
        />
      ),
  }
}

it('uses recognizable role and project names without mixing local and cloud IDs', async () => {
  const f = fixture([
    { id: '123456789', name: '本地项目', project_store: 'local' },
    { id: '123456789', name: '云端项目', project_store: 'backend' },
  ] as CollaborationProject[])
  f.settings.roles = ['first', 'second'].map(id => ({
    ...newStandInRole('mac', id),
    collaboration: {
      enabled: true,
      allProjects: false,
      projects: [
        { id: '123456789', store: 'local' },
        { id: '123456789', store: 'cloud' },
      ],
      excludedProjects: [],
      tags: [],
    },
  }))
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-add'))
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
    '所有分身（与你聊天时）',
    '默认分身（与你聊天时）',
    '默认分身 2（与你聊天时）',
    '项目 · 本地项目',
    '项目 · 云端项目',
  ])
  const scope = { kind: 'project', id: '123456789', store: 'cloud' }
  await user.selectOptions(
    screen.getByRole('combobox', { name: '在哪里使用' }),
    JSON.stringify(scope)
  )
  await user.type(screen.getByTestId('stand-in-memory-content'), '先检查项目约定')
  await user.click(screen.getByTestId('stand-in-memory-save'))
  await waitFor(() =>
    expect(f.api.saveMemory).toHaveBeenCalledWith(7, 'mac', {
      content: '先检查项目约定',
      scope,
    })
  )
  expect(await screen.findByText(/项目 · 云端项目 ·/)).toBeInTheDocument()
})

it('keeps an unavailable memory scope explicit until the user selects an available scope', async () => {
  const f = fixture()
  f.row.scope = { kind: 'project', id: 'removed-project', store: 'cloud' }
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  expect(screen.getByTestId('stand-in-memory-scope')).toHaveDisplayValue('原分身或工作来源暂不可用')
  expect(screen.getByTestId('stand-in-memory-save')).toBeDisabled()
  expect(f.api.saveMemory).not.toHaveBeenCalled()
  await user.selectOptions(
    screen.getByTestId('stand-in-memory-scope'),
    JSON.stringify({ kind: 'personal' })
  )
  await user.click(screen.getByTestId('stand-in-memory-save'))
  await waitFor(() =>
    expect(f.api.saveMemory).toHaveBeenCalledWith(7, 'mac', {
      ...f.row,
      scope: { kind: 'personal' },
    })
  )
})

it('selects the saved project by identity regardless of serialized property order', async () => {
  const f = fixture([
    { id: 'project', name: '评审项目', project_store: 'backend' },
  ] as CollaborationProject[])
  f.settings.roles[0].collaboration.projects = [{ id: 'project', store: 'cloud' }]
  f.row.scope = { id: 'project', kind: 'project', store: 'cloud' }
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  expect(screen.getByTestId('stand-in-memory-scope')).toHaveDisplayValue('项目 · 评审项目')
  await user.type(screen.getByTestId('stand-in-memory-content'), '，先列风险')
  await user.click(screen.getByTestId('stand-in-memory-save'))
  await waitFor(() =>
    expect(f.api.saveMemory).toHaveBeenCalledWith(7, 'mac', {
      ...f.row,
      content: '回复简洁，先列风险',
    })
  )
})

it('edits the exact version, changes scope, and confirms forgetting through the selected executor', async () => {
  const f = fixture()
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  await user.clear(screen.getByTestId('stand-in-memory-content'))
  await user.type(screen.getByTestId('stand-in-memory-content'), '评审时先列风险')
  await user.selectOptions(
    screen.getByTestId('stand-in-memory-scope'),
    JSON.stringify({ kind: 'role', roleId: 'review' })
  )
  await user.click(screen.getByTestId('stand-in-memory-save'))
  await waitFor(() =>
    expect(f.api.saveMemory).toHaveBeenCalledWith(7, 'mac', {
      ...f.row,
      content: '评审时先列风险',
      scope: { kind: 'role', roleId: 'review' },
    })
  )
  await user.click(await screen.findByTestId('stand-in-memory-delete'))
  expect(f.api.deleteMemory).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-delete-confirm'))
  await waitFor(() => expect(f.api.deleteMemory).toHaveBeenCalledWith(7, 'mac', 'memory-1', 3))
  expect(
    await screen.findByText('还没有记忆。你可以在聊天中说“记住……”，也可以在这里添加。')
  ).toBeInTheDocument()
})

it('preserves unsaved edits on failure and requires discarding before closing', async () => {
  const f = fixture()
  f.api.saveMemory.mockRejectedValue(new Error('task changed'))
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  await user.type(screen.getByTestId('stand-in-memory-content'), '，先问我')
  await user.click(screen.getByTestId('stand-in-memory-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '分身操作失败，请稍后重试；如仍失败，请查看执行设备日志。'
  )
  expect(screen.getByTestId('stand-in-memory-content')).toHaveValue('回复简洁，先问我')
  await user.click(screen.getByTestId('stand-in-memory-close'))
  expect(f.onClose).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-keep'))
  expect(screen.getByTestId('stand-in-memory-content')).toHaveValue('回复简洁，先问我')
})

it.each(['close', 'cancel'] as const)(
  'discards edits from %s and completes that action',
  async action => {
    const f = fixture()
    f.render()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('stand-in-memory-edit'))
    await user.type(screen.getByTestId('stand-in-memory-content'), ' changed')
    await user.click(screen.getByTestId(`stand-in-memory-${action}`))
    await user.click(screen.getByTestId('stand-in-memory-discard'))
    expect(screen.queryByTestId('stand-in-memory-content')).not.toBeInTheDocument()
    expect(f.onClose).toHaveBeenCalledTimes(action === 'close' ? 1 : 0)
    expect(f.api.saveMemory).not.toHaveBeenCalled()
  }
)

it('keeps project coordinator memory fixed to this project and hides personal memories', async () => {
  const f = fixture()
  const scope = { kind: 'project_coordinator' as const, id: 'project-a', store: 'local' as const }
  f.api.memories.mockResolvedValue([
    f.row,
    { ...f.row, id: 'project-note', scope, content: 'Project A goals' },
  ])
  render(
    <StandInMemoryPanel
      api={f.api as unknown as StandInExecutorApi}
      settings={f.settings}
      projects={[]}
      fixedScope={scope}
      scopeLabel="项目 A"
      onClose={f.onClose}
    />
  )
  expect(await screen.findByText('Project A goals')).toBeInTheDocument()
  expect(screen.queryByText('回复简洁')).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-memory-add'))
  expect(screen.getAllByRole('option')).toHaveLength(1)
  await user.type(screen.getByTestId('stand-in-memory-content'), 'Only project A')
  await user.click(screen.getByTestId('stand-in-memory-save'))
  await waitFor(() =>
    expect(f.api.saveMemory).toHaveBeenCalledWith(7, 'mac', { content: 'Only project A', scope })
  )
})
