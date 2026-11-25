import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationIssue, CollaborationStatus } from '../types'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'
import { createIssueCommentActions, type IssueCommentBoardContext } from './issueCommentActions'

const t = createCollaborationTranslator('zh-CN')
const statuses = ['inbox', 'in_progress', 'completed'].map(id => ({
  id,
  name: id,
  color: 'gray',
})) as CollaborationStatus[]
const lane = (key: string, type: 'tag' | 'status', value = key) => ({
  key,
  type,
  groupValue: value,
  label: value,
  dotClass: '',
  status: type === 'status' ? value : '',
})
const board: IssueCommentBoardContext = {
  name: '研发视图',
  groupBy: 'tag',
  sourceColumnKey: '开发中',
  columns: [
    lane('开发中', 'tag'),
    lane('待验收', 'tag'),
    lane('关闭', 'tag'),
    lane('完成', 'status', 'completed'),
  ],
}
const original = {
  id: 'issue',
  cloud_project_id: 'project',
  status: 'in_progress',
  tags: ['开发中', '紧急'],
  priority: 'high',
  version: 3,
} as CollaborationIssue

function setup(overrides: Partial<Parameters<typeof createIssueCommentActions>[0]> = {}) {
  const get = vi.fn().mockResolvedValue({
    ...original,
    version: 9,
    tags: [...original.tags, '客户反馈'],
  })
  const update = vi.fn(async (_id, patch) => ({
    ...original,
    ...patch,
    version: 10,
  }))
  const onUpdated = vi.fn()
  const actions = createIssueCommentActions({
    issue: original,
    board,
    statuses,
    editable: true,
    canAssign: true,
    issues: {
      get,
      update,
    } as unknown as SharedIssueDetailPort['issues'],
    onUpdated,
    confirmAssignee: vi.fn(async () => true),
    translate: t,
    ...overrides,
  })
  return { actions, get, update, onUpdated }
}

describe('Issue composer board operations', () => {
  it.each([false, true])('confirms assignee column moves (approved=%s)', async approved => {
    const confirmAssignee = vi.fn(async () => approved)
    const { actions, update, onUpdated } = setup({
      confirmAssignee,
      board: {
        name: 'People',
        groupBy: 'assignee',
        columns: ['', 'user:5'].map(groupValue => ({
          key: groupValue || 'unassigned',
          type: 'assignee',
          groupValue,
          label: groupValue || 'Unassigned',
          dotClass: '',
          status: '',
        })),
      },
    })
    const result = await actions.move(JSON.stringify(['unassigned', 'user:5']))
    expect(confirmAssignee).toHaveBeenCalledExactlyOnceWith('user:5')
    if (approved) {
      expect(update).toHaveBeenCalledExactlyOnceWith('issue', {
        version: 9,
        assignee_user_id: 5,
        assignee_agent_id: null,
        assignee_team_id: null,
        notify_assignee: true,
      })
      expect(onUpdated).toHaveBeenCalledOnce()
    } else {
      expect(result).toBe(false)
      expect(update).not.toHaveBeenCalled()
      expect(onUpdated).not.toHaveBeenCalled()
    }
  })

  it('uses the selected view and source column without writing until submission', async () => {
    const { actions, update, onUpdated } = setup()
    expect(actions.boardName).toBe('研发视图')
    expect(actions.currentColumns).toEqual(['开发中'])
    expect(update).not.toHaveBeenCalled()
    await actions.move(JSON.stringify(['开发中', '待验收']))
    expect(update).toHaveBeenCalledWith('issue', {
      version: 9,
      tags: ['紧急', '客户反馈', '待验收'],
    })
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 10 }))
  })

  it('does not treat a tag named closed as an Issue lifecycle change', async () => {
    const { actions, update } = setup()
    await actions.move(JSON.stringify(['开发中', '关闭']))
    expect(update.mock.calls[0][1]).toEqual({
      version: 9,
      tags: ['紧急', '客户反馈', '关闭'],
    })
  })

  it('moves to a status lane without discarding tags', async () => {
    const { actions, update } = setup()
    await actions.move(JSON.stringify(['开发中', '完成']))
    expect(update).toHaveBeenCalledWith('issue', {
      version: 9,
      status: 'completed',
    })
  })

  it('offers explicit source-to-destination choices when the Issue belongs to multiple tag lanes', () => {
    const { actions } = setup({
      issue: { ...original, tags: ['开发中', '待验收', '紧急'] },
      board: { ...board, sourceColumnKey: undefined },
    })
    expect(actions.currentColumns).toEqual(['开发中', '待验收'])
    expect(
      actions.moves.filter(option => option.label.endsWith(' → 关闭')).map(option => option.label)
    ).toEqual(['开发中 → 关闭', '待验收 → 关闭'])
  })

  it('preserves a concurrent move and asks for a new selection', async () => {
    const { actions, get, update } = setup()
    get.mockResolvedValue({
      ...original,
      tags: ['其它阶段', '紧急'],
      version: 11,
    })
    await expect(actions.move(JSON.stringify(['开发中', '待验收']))).rejects.toThrow(
      '来源泳道已变化'
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects tag overflow without truncating existing tags', async () => {
    const { actions, get, update } = setup({
      board: {
        ...board,
        sourceColumnKey: 'current',
        columns: [lane('current', 'status', 'in_progress'), lane('待验收', 'tag')],
      },
    })
    get.mockResolvedValue({
      ...original,
      tags: Array.from({ length: 20 }, (_, index) => `tag-${index}`),
    })
    await expect(actions.move(JSON.stringify(['current', '待验收']))).rejects.toThrow('20')
    expect(update).not.toHaveBeenCalled()
  })

  it('closes using the existing completed state and reopens to the previous workflow state', async () => {
    const { actions, get, update } = setup()
    await actions.toggle(true)
    expect(update).toHaveBeenLastCalledWith('issue', {
      version: 9,
      status: 'completed',
    })
    get.mockResolvedValue({
      ...original,
      version: 11,
      status: 'completed',
      status_history: [{ from_status: 'in_progress', to_status: 'completed' }],
    })
    await actions.toggle(false)
    expect(update).toHaveBeenLastCalledWith('issue', {
      version: 11,
      status: 'in_progress',
    })
  })

  it('does not offer or execute editing actions for a read-only Issue', async () => {
    const { actions, update } = setup({ editable: false, canAssign: false })
    expect(actions.moves).toEqual([])
    expect(actions.canToggle).toBe(false)
    await expect(actions.toggle(true)).rejects.toThrow()
    await expect(actions.move(JSON.stringify(['开发中', '待验收']))).rejects.toThrow()
    expect(update).not.toHaveBeenCalled()
  })

  it('does not invent a completion state for projects without one', () => {
    expect(
      setup({
        statuses: statuses.filter(status => status.id !== 'completed'),
      }).actions.canToggle
    ).toBe(false)
  })
})
