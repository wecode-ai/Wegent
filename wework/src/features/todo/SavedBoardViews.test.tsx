// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import {
  BoardViewNavigation,
  BoardViewNotice,
  BoardViewEditor,
  createCollaborationTranslator,
  useSavedBoardViews,
  type ProjectBoardViews,
} from '@wegent/collaboration'

const translate = createCollaborationTranslator('zh-CN')
const statuses = [
  { id: 'inbox', name: '收集箱', color: 'gray' as const },
  { id: 'completed', name: '已完成', color: 'green' as const },
]
const config: ProjectBoardViews = {
  schema_version: 1,
  futureField: { keepCase: true },
  views: [
    {
      id: 'mixed',
      name: 'Mixed',
      futureViewField: 42,
      columns: [
        { id: 'done', type: 'status', value: 'completed', futureColumnField: true },
        { id: 'a', type: 'tag', value: 'a' },
      ],
      filter: { tags: ['a'], match: 'all' },
      sorts: { done: ['created-asc'] },
    },
  ],
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false
    },
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

describe('saved project board views', () => {
  it('uses the existing default without writing or migrating a historical project', () => {
    const save = vi.fn()
    const { result } = renderHook(() =>
      useSavedBoardViews({ projectKey: 'local:one', revision: 1, translate, save })
    )
    expect(result.current.view).toBeNull()
    expect(result.current.views).toEqual([])
    expect(save).not.toHaveBeenCalled()
  })

  it('opens the project default on entry while keeping explicit switches local to the current visit', () => {
    const save = vi.fn()
    const { result, rerender } = renderHook(
      ({ projectKey }) =>
        useSavedBoardViews({
          projectKey,
          config: { ...config, default_view_id: 'mixed' },
          revision: 1,
          translate,
          save,
        }),
      { initialProps: { projectKey: 'backend:one' } }
    )
    expect(result.current.view?.id).toBe('mixed')
    act(() => result.current.select('default'))
    expect(result.current.view).toBeNull()
    rerender({ projectKey: 'local:two' })
    expect(result.current.view?.id).toBe('mixed')
    rerender({ projectKey: 'backend:one' })
    expect(result.current.view?.id).toBe('mixed')
    expect(save).not.toHaveBeenCalled()
  })

  it('saves the default and card fields together, and resets a deleted default to the status board', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const initial = { ...config, default_view_id: 'mixed' }
    const { result } = renderHook(() =>
      useSavedBoardViews({ projectKey: 'one', config: initial, revision: 1, translate, save })
    )
    const preferences = {
      isDefault: false,
      cardDisplay: { show_assignee: false, show_priority: true, show_tags: true, show_date: true },
    }
    await act(() => result.current.saveView(config.views[0], 1, preferences))
    expect(save).toHaveBeenLastCalledWith({ ...initial, default_view_id: 'default' }, preferences)
    await act(() => result.current.deleteView('mixed'))
    expect(save).toHaveBeenLastCalledWith({ ...initial, default_view_id: 'default', views: [] })
    expect(result.current.view).toBeNull()
  })

  it('uses one menu and one settings form for lanes, default selection, preview and card fields', async () => {
    const user = userEvent.setup()
    const save = vi.fn().mockResolvedValue(undefined)
    function Harness() {
      const controller = useSavedBoardViews({
        projectKey: 'one',
        config,
        revision: 1,
        translate,
        save,
      })
      return (
        <BoardViewNavigation
          controller={controller}
          canManage
          statuses={statuses}
          tags={['a']}
          translate={translate}
          settings={{ canEditStatuses: true }}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByTestId('board-view-navigation').querySelectorAll('button')).toHaveLength(1)
    await user.click(screen.getByTestId('board-view-picker'))
    await user.click(screen.getByTestId('board-view-mixed'))
    await user.click(screen.getByTestId('board-view-picker'))
    await user.click(screen.getByTestId('board-view-edit'))
    expect(screen.queryByTestId('board-view-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-view-preview-done')).toHaveTextContent('已完成')
    expect(screen.getByTestId('board-view-preview-a')).toHaveTextContent('a')
    await user.click(screen.getByTestId('board-view-set-default'))
    await user.click(screen.getByTestId('cloud-board-display-menu'))
    await user.click(screen.getByTestId('cloud-board-display-tags'))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('cloud-project-card-display-settings')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-view-editor')).toBeVisible()
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('board-view-save'))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledWith(
      { ...config, default_view_id: 'mixed' },
      {
        isDefault: true,
        cardDisplay: {
          show_assignee: true,
          show_priority: true,
          show_tags: false,
          show_date: true,
        },
      }
    )
    expect(screen.queryByTestId('board-view-editor')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-view-picker')).toHaveFocus()
  })

  it('keeps status menus inside the unified dialog and stages workflow edits until save', async () => {
    const user = userEvent.setup()
    const save = vi.fn().mockResolvedValue(undefined)
    render(
      <BoardViewEditor
        initial={{ id: 'default', name: '状态看板', columns: [] }}
        statuses={statuses}
        tags={[]}
        translate={translate}
        settings={{ defaultViewId: 'default', canEditStatuses: true }}
        onSave={save}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByTestId('cloud-board-status-menu-inbox'))
    expect(screen.getByTestId('board-view-editor')).toContainElement(
      screen.getByTestId('cloud-board-status-rename-inbox')
    )
    await user.click(screen.getByTestId('cloud-board-status-rename-inbox'))
    const input = screen.getByTestId('cloud-board-status-name-inbox')
    await user.clear(input)
    await user.type(input, '待归类')
    await user.keyboard('{Enter}')
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('board-view-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          boardConfig: expect.objectContaining({
            statuses: [{ ...statuses[0], name: '待归类' }, statuses[1]],
          }),
        })
      )
    )
  })

  it('preserves unknown fields, isolates project selection, and rejects a stale editor', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ projectKey, revision }) =>
        useSavedBoardViews({ projectKey, config, revision, translate, save }),
      {
        initialProps: { projectKey: 'backend:one', revision: 1 },
      }
    )
    act(() => result.current.select('mixed'))
    const edited = { ...result.current.view!, name: 'Edited' }
    await act(() => result.current.saveView(edited, 1))
    expect(save).toHaveBeenCalledWith({ ...config, views: [edited] })
    rerender({ projectKey: 'backend:one', revision: 2 })
    await expect(result.current.saveView(edited, 1)).rejects.toThrow('项目已被更新')
    expect(save).toHaveBeenCalledTimes(1)
    rerender({ projectKey: 'local:one', revision: 1 })
    expect(result.current.view).toBeNull()
  })

  it('does not expose editing or erase a future document', async () => {
    const save = vi.fn()
    const { result } = renderHook(() =>
      useSavedBoardViews({
        projectKey: 'one',
        config: { schema_version: 2, views: [], future: true },
        revision: 1,
        translate,
        save,
      })
    )
    render(
      <BoardViewNavigation
        controller={result.current}
        canManage
        statuses={statuses}
        tags={['a']}
        translate={translate}
      />
    )
    expect(screen.queryByTestId('board-view-new')).not.toBeInTheDocument()
    render(
      <BoardViewNotice controller={result.current} statuses={statuses} translate={translate} />
    )
    expect(screen.getByRole('status')).toHaveTextContent('更新版本')
    await expect(result.current.deleteView('anything')).rejects.toThrow('更新版本')
    expect(save).not.toHaveBeenCalled()
  })

  it('hides management for readers while allowing saved view selection', () => {
    const { result } = renderHook(() =>
      useSavedBoardViews({ projectKey: 'one', config, revision: 1, translate, save: vi.fn() })
    )
    render(
      <BoardViewNavigation
        controller={result.current}
        canManage={false}
        statuses={statuses}
        tags={['a']}
        translate={translate}
      />
    )
    expect(screen.queryByTestId('board-view-mixed')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('board-view-picker'))
    expect(screen.getByTestId('board-view-mixed')).toBeVisible()
    expect(screen.queryByTestId('board-view-new')).not.toBeInTheDocument()
  })

  it.each(['lane', 'filter'] as const)(
    'does not treat an unused tag in a %s as a deleted reference',
    source => {
      const save = vi.fn()
      const initial = config.views[0]
      const unusedTags: ProjectBoardViews = {
        ...config,
        views: [
          {
            ...initial,
            columns: source === 'lane' ? initial.columns : [initial.columns[0]],
            filter: { tags: source === 'filter' ? ['unused'] : [], match: 'all' },
          },
        ],
      }
      function Harness() {
        const controller = useSavedBoardViews({
          projectKey: 'one',
          config: unusedTags,
          revision: 1,
          translate,
          save,
        })
        return (
          <>
            <BoardViewNavigation
              controller={controller}
              canManage
              statuses={statuses}
              tags={[]}
              translate={translate}
            />
            <BoardViewNotice controller={controller} statuses={statuses} translate={translate} />
          </>
        )
      }
      render(<Harness />)
      fireEvent.click(screen.getByTestId('board-view-picker'))
      fireEvent.click(screen.getByTestId('board-view-mixed'))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(save).not.toHaveBeenCalled()
    }
  )

  it('still reports a status lane whose status no longer exists', () => {
    const save = vi.fn()
    function Harness() {
      const controller = useSavedBoardViews({
        projectKey: 'one',
        config,
        revision: 1,
        translate,
        save,
      })
      return (
        <>
          <BoardViewNavigation
            controller={controller}
            canManage
            statuses={statuses.filter(status => status.id !== 'completed')}
            tags={['a']}
            translate={translate}
          />
          <BoardViewNotice
            controller={controller}
            statuses={statuses.filter(status => status.id !== 'completed')}
            translate={translate}
          />
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-mixed'))
    expect(screen.getByRole('status')).toHaveTextContent('状态已不存在')
    expect(save).not.toHaveBeenCalled()
  })

  it('opens views with omitted filters as an unrestricted view', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(
      <BoardViewEditor
        initial={{ ...config.views[0], filter: undefined }}
        statuses={statuses}
        tags={['a']}
        translate={translate}
        onSave={save}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('board-view-filter-match')).toHaveValue('all')
    expect(screen.getByTestId('board-view-filter-tag-a')).not.toBeChecked()
    fireEvent.click(screen.getByTestId('board-view-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { tags: [], match: 'all' } })
      )
    )
  })

  function renderTagView(tags = ['bug', '测试', '需求']) {
    const save = vi.fn().mockResolvedValue(undefined)
    render(
      <BoardViewEditor
        initial={{
          ...config.views[0],
          columns: [
            { id: 'bug', type: 'tag', value: 'bug' },
            { id: 'test', type: 'tag', value: '测试' },
          ],
          filter: { tags: [] },
        }}
        statuses={statuses}
        tags={tags}
        translate={translate}
        onSave={save}
        onClose={vi.fn()}
      />
    )
    return save
  }

  it('opens all tags independently of the current value and contains the popup inside its dialog', async () => {
    const user = userEvent.setup()
    const save = renderTagView()
    await user.click(screen.getByTestId('board-view-lane-value-0'))
    expect(screen.getByTestId('board-view-lane-value-0-search')).toHaveValue('')
    for (const tag of ['bug', '测试', '需求'])
      expect(screen.getByTestId(`board-view-lane-value-0-option-${tag}`)).toBeVisible()
    expect(screen.getByTestId('board-view-lane-value-0-option-bug')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('board-view-lane-value-0-option-测试')).toBeDisabled()
    expect(screen.getByTestId('board-view-editor')).toContainElement(
      screen.getByTestId('board-view-lane-value-0-popover')
    )
    await user.click(screen.getByTestId('board-view-lane-value-0-option-需求'))
    expect(screen.getByTestId('board-view-lane-value-0')).toHaveTextContent('需求')
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('board-view-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          columns: [
            { id: 'bug', type: 'tag', value: '需求' },
            { id: 'test', type: 'tag', value: '测试' },
          ],
        })
      )
    )
  })

  it('clears search on reopen and Escape closes only the picker without changing its binding', async () => {
    const user = userEvent.setup()
    const save = renderTagView()
    await user.click(screen.getByTestId('board-view-lane-value-0'))
    await user.type(screen.getByTestId('board-view-lane-value-0-search'), 'bu')
    expect(screen.getByTestId('board-view-lane-value-0-option-bug')).toBeVisible()
    expect(screen.queryByTestId('board-view-lane-value-0-option-需求')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('board-view-lane-value-0-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-view-editor')).toBeInTheDocument()
    expect(screen.getByTestId('board-view-lane-value-0')).toHaveTextContent('bug')
    await user.click(screen.getByTestId('board-view-lane-value-0'))
    expect(screen.getByTestId('board-view-lane-value-0-search')).toHaveValue('')
    expect(screen.getByTestId('board-view-lane-value-0-option-需求')).toBeVisible()
    expect(save).not.toHaveBeenCalled()
  })

  it('creates a trimmed tag with Enter while preserving IME composition and the unsaved view', async () => {
    const user = userEvent.setup()
    const save = renderTagView()
    await user.click(screen.getByTestId('board-view-lane-value-0'))
    const search = screen.getByTestId('board-view-lane-value-0-search')
    await user.type(search, '  新标签  ')
    expect(screen.getByTestId('board-view-lane-value-0-create')).toHaveTextContent(
      '新建标签「新标签」'
    )
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(screen.getByTestId('board-view-lane-value-0-popover')).toBeInTheDocument()
    expect(screen.getByTestId('board-view-lane-value-0')).toHaveTextContent('bug')
    await user.keyboard('{Enter}')
    expect(screen.queryByTestId('board-view-lane-value-0-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-view-lane-value-0')).toHaveTextContent('新标签')
    expect(screen.getByTestId('board-view-filter-tag-新标签')).not.toBeChecked()
    expect(save).not.toHaveBeenCalled()
  })

  it('navigates selectable tags by keyboard and skips tags used in another lane', async () => {
    const user = userEvent.setup()
    renderTagView()
    await user.click(screen.getByTestId('board-view-lane-value-0'))
    expect(screen.getByTestId('board-view-lane-value-0-search')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('board-view-lane-value-0-option-bug')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('board-view-lane-value-0-option-需求')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('board-view-lane-value-0')).toHaveTextContent('需求')
  })

  it('edits a mixed view, preserves input after failure, and deletes only its configuration', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Conflict')).mockResolvedValue(undefined)
    function Harness() {
      const controller = useSavedBoardViews({
        projectKey: 'one',
        config,
        revision: 1,
        translate,
        save,
      })
      return (
        <BoardViewNavigation
          controller={controller}
          canManage
          statuses={statuses}
          tags={['a', 'b']}
          translate={translate}
        />
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-mixed'))
    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-edit'))
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-done'))
    expect(screen.getByTestId('board-view-editor')).toContainElement(
      screen.getByTestId('cloud-board-sort-by-done-popover')
    )
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-done-manual'))
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-done'))
    fireEvent.change(screen.getByTestId('board-view-name'), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByTestId('board-view-lane-up-1'))
    fireEvent.click(screen.getByTestId('board-view-filter-tag-b'))
    fireEvent.click(screen.getByTestId('board-view-save'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Conflict'))
    expect(screen.getByTestId('board-view-name')).toHaveValue('Changed')
    expect(save.mock.calls[0][0]).toMatchObject({
      futureField: { keepCase: true },
      views: [
        {
          name: 'Changed',
          futureViewField: 42,
          columns: [
            { id: 'a', type: 'tag' },
            { id: 'done', type: 'status', futureColumnField: true },
          ],
          filter: { tags: ['a', 'b'], match: 'all' },
          sorts: { done: [] },
        },
      ],
    })
    fireEvent.click(screen.getByTestId('board-view-delete'))
    expect(save).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('board-view-delete'))
    await waitFor(() => expect(screen.queryByTestId('board-view-editor')).not.toBeInTheDocument())
    expect(save.mock.calls[1][0]).toEqual({ ...config, views: [] })
  })
})
