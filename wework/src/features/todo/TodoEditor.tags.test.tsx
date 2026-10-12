import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'

const item = {
  id: 'TAG-1',
  cloud_project_id: '11',
  title: 'Inspect tags',
  description: '',
  status: 'inbox',
  priority: 'none',
  parent_id: null,
  due_at: null,
  tags: [],
  assignee_user_id: null,
  assignee_agent_id: null,
  created_at: '2026-10-08T12:00:00Z',
  updated_at: '2026-10-08T12:00:00Z',
  version: 1,
  can_edit: true,
} as CloudLoopItem
const project = { id: '11', name: 'Wework', tags: ['发布', '体验'] } as CloudProject

async function openEditor(options: { canEdit?: boolean; saveError?: Error } = {}) {
  const current = { ...item, can_edit: options.canEdit ?? true }
  const updateLoopItem = vi.fn(async (_id: string, values: Partial<CloudLoopItem>) => {
    if (options.saveError) throw options.saveError
    return { ...current, ...values, version: current.version + 1 }
  })
  const api = {
    listDeliveries: vi.fn(async () => ({ items: [] })),
    listTaskBindings: vi.fn(async () => []),
    listLoopItemAttachments: vi.fn(async () => []),
    listLoopItemCollaborators: vi.fn(async () => []),
    listCloudProjectMembers: vi.fn(async () => []),
    updateLoopItem,
  } as never
  const onUpdated = vi.fn()
  const onClose = vi.fn()
  render(
    <TodoEditor
      mode="edit"
      presentation="workspace-panel"
      item={current}
      project={project}
      allItems={[current]}
      api={api}
      onUpdated={onUpdated}
      onClose={onClose}
    />
  )
  await userEvent.click(screen.getByTestId('cloud-todo-more-properties'))
  return { updateLoopItem, onUpdated, onClose }
}

describe('workspace Issue tag editing', () => {
  it('shows typed text, commits unique tags, removes them and saves the draft', async () => {
    const { updateLoopItem, onUpdated } = await openEditor()
    const input = screen.getByRole('textbox', { name: '添加标签' })
    expect(input).toBeVisible()
    expect(input.closest('.task-detail-rail-value')).not.toHaveClass('truncate')
    expect(input.closest('.task-detail-rail-value-content')).not.toHaveClass('truncate')
    await userEvent.type(input, '新标签')
    expect(input).toHaveValue('新标签')
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-新标签')).toBeVisible()
    await userEvent.type(input, '新标签,')
    expect(screen.getAllByTestId('cloud-todo-detail-tag-tag-新标签')).toHaveLength(1)
    await userEvent.type(input, '临时标签,')
    await userEvent.click(screen.getByTestId('cloud-todo-detail-tag-tag-remove-临时标签'))
    expect(screen.queryByTestId('cloud-todo-detail-tag-tag-临时标签')).not.toBeInTheDocument()
    expect(updateLoopItem).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ version: 1, tags: ['新标签'] })
      )
    )
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ tags: ['新标签'] }))
  })

  it('offers project tags and commits on blur without stealing focus', async () => {
    await openEditor()
    const input = screen.getByTestId('cloud-todo-detail-tag-input')
    await userEvent.click(input)
    await userEvent.click(screen.getByTestId('cloud-todo-detail-tag-suggestion-发布'))
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-发布')).toBeVisible()
    await userEvent.type(input, '核对')
    const title = screen.getByTestId('cloud-todo-detail-title')
    await userEvent.click(title)
    expect(title).toHaveFocus()
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-more-properties'))
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-核对')).toBeVisible()
  })

  it('does not commit a tag when Enter confirms IME composition', async () => {
    await openEditor()
    const input = screen.getByTestId('cloud-todo-detail-tag-input')
    await userEvent.click(input)
    fireEvent.change(input, { target: { value: '验证' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(input).toHaveValue('验证')
    expect(screen.queryByTestId('cloud-todo-detail-tag-tag-验证')).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-验证')).toBeVisible()
  })

  it('keeps tags available for retry after a rejected save', async () => {
    const { updateLoopItem } = await openEditor({ saveError: new Error('保存标签失败') })
    await userEvent.type(screen.getByTestId('cloud-todo-detail-tag-input'), '验证{Enter}')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))
    expect(await screen.findByText('保存标签失败')).toBeVisible()
    await userEvent.click(screen.getByTestId('cloud-todo-more-properties'))
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-验证')).toBeVisible()
    expect(screen.getByTestId('cloud-todo-save')).toBeEnabled()
    expect(updateLoopItem).toHaveBeenCalledTimes(1)
  })

  it('does not offer tag editing without edit permission', async () => {
    const { updateLoopItem } = await openEditor({ canEdit: false })
    expect(screen.queryByTestId('cloud-todo-detail-tag-input')).not.toBeInTheDocument()
    expect(updateLoopItem).not.toHaveBeenCalled()
  })

  it('closes on an outside click and preserves an uncommitted tag for saving', async () => {
    const { updateLoopItem, onClose } = await openEditor()
    const trigger = screen.getByTestId('cloud-todo-more-properties')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await userEvent.type(screen.getByTestId('cloud-todo-detail-tag-input'), '待保存')
    await userEvent.click(screen.getByTestId('cloud-todo-detail-title'))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(trigger)
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-待保存')).toBeVisible()
    await userEvent.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ tags: ['待保存'] })
      )
    )
  })

  it('keeps internal clicks open and closes only the popover on Escape', async () => {
    const { onClose } = await openEditor()
    const trigger = screen.getByTestId('cloud-todo-more-properties')
    await userEvent.click(screen.getByTestId('cloud-todo-detail-priority'))
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
  })
})
