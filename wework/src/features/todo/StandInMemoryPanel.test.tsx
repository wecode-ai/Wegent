import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInMemory, StandInMemoryRule } from '@/api/standIn'
import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CollaborationProject } from '@wegent/collaboration'
import { expect, it, vi } from 'vitest'
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
    memoryRules: vi.fn(async (): Promise<StandInMemoryRule[]> => []),
    deleteMemoryRule: vi.fn(async () => {}),
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
    render: (onBack?: () => void, parentLabel?: string) =>
      render(
        <StandInMemoryPanel
          api={api as unknown as StandInExecutorApi}
          settings={settings}
          projects={projects}
          onClose={onClose}
          onBack={onBack}
          parentLabel={parentLabel}
        />
      ),
  }
}

it('uses the actual role settings parent in the breadcrumb', async () => {
  const f = fixture()
  const onBack = vi.fn()
  f.render(onBack, '角色设置')
  const parent = await screen.findByTestId('stand-in-memory-path-settings')
  expect(parent).toHaveTextContent('角色设置')
  await userEvent.click(parent)
  expect(onBack).toHaveBeenCalledOnce()
})

it.each(['stand-in-memory-back', 'stand-in-memory-path-settings'])(
  'returns to settings through %s without silently discarding memory edits',
  async testId => {
    const f = fixture()
    const onBack = vi.fn()
    f.render(onBack)
    expect(screen.queryByRole('heading', { name: '记忆' })).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('stand-in-memory-edit'))
    const editor = screen.getByTestId('stand-in-memory-content')
    await user.type(editor, ' changed')
    await user.click(screen.getByTestId(testId))
    expect(onBack).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-memory-keep'))
    expect(editor).toHaveValue('回复简洁 changed')
    await user.click(screen.getByTestId(testId))
    await user.click(screen.getByTestId('stand-in-memory-discard'))
    expect(onBack).toHaveBeenCalledOnce()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.api.saveMemory).not.toHaveBeenCalled()
  }
)

it('loads rules on demand and refreshes after forgetting without mixing active memories', async () => {
  const f = fixture()
  let rules: StandInMemoryRule[] = []
  f.api.memoryRules.mockImplementation(async () => rules)
  f.api.deleteMemory.mockImplementation(async () => {
    rules = [{ ...f.row, id: 'rule-1', kind: 'forgetting_rule', version: 1 }]
  })
  f.render()
  const user = userEvent.setup()
  await screen.findByTestId('stand-in-memory-item')
  expect(f.api.memoryRules).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-rules-toggle'))
  expect(await screen.findByText('暂无遗忘规则。')).toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-memory-delete'))
  expect(screen.getByText(/并保留其简短事实和作用域作为遗忘规则/)).toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-memory-delete-confirm'))
  expect(await screen.findByTestId('stand-in-memory-rule')).toHaveTextContent(f.row.content)
  expect(screen.queryByTestId('stand-in-memory-item')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-memory-rule-delete'))
  expect(screen.getByText(/不会立即恢复记忆/)).toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-memory-rule-delete-cancel'))
  expect(f.api.deleteMemoryRule).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-rule-delete'))
  await user.click(screen.getByTestId('stand-in-memory-rule-delete-confirm'))
  await waitFor(() => expect(f.api.deleteMemoryRule).toHaveBeenCalledWith(7, 'mac', 'rule-1', 1))
  expect(await screen.findByText('规则已删除，后续可以重新学习。')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-memory-rule')).not.toBeInTheDocument()
  expect(f.api.saveMemory).not.toHaveBeenCalled()
})

it('keeps memories usable when rule loading fails and offers local recovery', async () => {
  const f = fixture()
  f.api.memoryRules.mockRejectedValueOnce(new Error('unavailable'))
  f.render()
  const user = userEvent.setup()
  await screen.findByTestId('stand-in-memory-item')
  await user.click(screen.getByTestId('stand-in-memory-rules-toggle'))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.queryByText('暂无遗忘规则。')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-memory-edit')).toBeEnabled()
  await user.click(screen.getByTestId('stand-in-memory-rules-retry'))
  expect(await screen.findByText('暂无遗忘规则。')).toBeInTheDocument()
})

it('retains a rule after failed deletion and requires refreshed state before another delete', async () => {
  const f = fixture()
  f.api.memoryRules.mockResolvedValue([{ ...f.row, id: 'rule-1', kind: 'forgetting_rule' }])
  f.api.deleteMemoryRule.mockRejectedValueOnce(new Error('Version conflict'))
  f.render()
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-memory-rules-toggle'))
  await user.click(await screen.findByTestId('stand-in-memory-rule-delete'))
  await user.click(screen.getByTestId('stand-in-memory-rule-delete-confirm'))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.getByTestId('stand-in-memory-rule')).toHaveTextContent(f.row.content)
  expect(screen.getByTestId('stand-in-memory-rule-delete-confirm')).toBeDisabled()
  await user.click(screen.getByTestId('stand-in-memory-rules-retry'))
  await waitFor(() => expect(screen.getByTestId('stand-in-memory-rule-delete')).toBeEnabled())
})

it('keeps an unavailable memory scope explicit until the user selects an available scope', async () => {
  const f = fixture()
  f.row.scope = { kind: 'project', id: 'removed-project', store: 'cloud' }
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  expect(screen.getByTestId('stand-in-memory-scope')).toHaveDisplayValue('原助理或工作来源暂不可用')
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

it('discloses stored evidence as plain text without treating an assistant quote as a user fact', async () => {
  const f = fixture()
  f.row.evidence = {
    taskId: 'source-chat',
    messageId: 'message-1',
    role: 'assistant',
    excerpt: '<script>untrusted source</script>',
  }
  f.render()
  const evidence = await screen.findByTestId('stand-in-memory-evidence')
  expect(evidence).not.toHaveAttribute('open')
  await userEvent.setup().click(screen.getByTestId('stand-in-memory-evidence-toggle'))
  expect(evidence).toHaveAttribute('open')
  expect(evidence).toHaveTextContent('助手原话（不代表用户事实）')
  expect(evidence).toHaveTextContent('source-chat')
  expect(evidence).toHaveTextContent('<script>untrusted source</script>')
  expect(evidence.querySelector('script')).toBeNull()
  expect(f.api.saveMemory).not.toHaveBeenCalled()
})

it('does not invent evidence for memories without a saved excerpt', async () => {
  const f = fixture()
  f.render()
  await screen.findByTestId('stand-in-memory-item')
  expect(screen.queryByTestId('stand-in-memory-evidence-toggle')).not.toBeInTheDocument()
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

it('preserves unsaved edits on failure and requires discarding before closing', async () => {
  const f = fixture()
  f.api.saveMemory.mockRejectedValue(new Error('task changed'))
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  await user.type(screen.getByTestId('stand-in-memory-content'), '，先问我')
  await user.click(screen.getByTestId('stand-in-memory-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '暂时无法完成此操作。请保留当前修改，重新加载后再试。'
  )
  expect(screen.getByTestId('stand-in-memory-content')).toHaveValue('回复简洁，先问我')
  await user.click(screen.getByTestId('stand-in-memory-close'))
  expect(f.onClose).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-keep'))
  expect(screen.getByTestId('stand-in-memory-content')).toHaveValue('回复简洁，先问我')
})

it.each(['cancel'] as const)('discards edits from %s and completes that action', async action => {
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
})

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
