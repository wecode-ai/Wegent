// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IssueHierarchySummary } from './IssueHierarchySummary'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationIssue } from '../types'

const issue = (id: string, parent_id: string | null, status = 'in_progress') =>
  ({
    id,
    parent_id,
    status,
    title: id,
    cloud_project_id: 'project',
  }) as CollaborationIssue

describe('IssueHierarchySummary', () => {
  it('navigates both directions and excludes restricted or foreign related issues', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div'),
      root = createRoot(container)
    const parent = issue('parent', null),
      item = issue('item', 'parent')
    const child = issue('child', 'item', 'completed')
    const hidden = { ...issue('restricted', 'item'), can_view_detail: false }
    const foreign = { ...issue('foreign', 'item'), cloud_project_id: 'other' }
    const onOpen = vi.fn(),
      onAddChild = vi.fn()
    const t = createCollaborationTranslator('zh-CN')
    try {
      act(() =>
        root.render(
          <IssueHierarchySummary
            item={item}
            allItems={[parent, item, child, hidden, foreign]}
            onOpen={onOpen}
            onAddChild={onAddChild}
            translate={t}
          />,
        ),
      )
      expect(container.textContent).toContain('1/1 已完成')
      expect(container.textContent).not.toContain('restricted')
      expect(container.textContent).not.toContain('foreign')
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="issue-parent-link"]',
          )!
          .click(),
      )
      expect(onOpen).toHaveBeenLastCalledWith(parent)
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="issue-hierarchy-child-child"]',
          )!
          .click(),
      )
      expect(onOpen).toHaveBeenLastCalledWith(child)
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="issue-hierarchy-add-child"]',
          )!
          .click(),
      )
      expect(onAddChild).toHaveBeenCalledOnce()
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="issue-children-toggle"]',
          )!
          .click(),
      )
      expect(
        container.querySelector('[data-testid="issue-hierarchy-child-child"]'),
      ).toBeNull()
    } finally {
      act(() => root.unmount())
    }
  })
  it('does not offer a hidden parent or a creation action in a read-only detail', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div'),
      root = createRoot(container)
    try {
      act(() =>
        root.render(
          <IssueHierarchySummary
            item={issue('item', 'hidden')}
            allItems={[{ ...issue('hidden', null), can_view_detail: false }]}
            onOpen={vi.fn()}
            translate={createCollaborationTranslator('en')}
          />,
        ),
      )
      expect(container.innerHTML).toBe('')
    } finally {
      act(() => root.unmount())
    }
  })
})

it('keeps the creation entry without a meaningless zero-of-zero completion label', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  const root = createRoot(container)
  const onAddChild = vi.fn()
  try {
    act(() =>
      root.render(
        <IssueHierarchySummary
          item={issue('parent', null)}
          allItems={[]}
          onOpen={vi.fn()}
          onAddChild={onAddChild}
          translate={createCollaborationTranslator('zh-CN')}
        />,
      ),
    )
    expect(
      container.querySelector('[data-testid="issue-children-progress"]'),
    ).toBeNull()
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="issue-hierarchy-add-child"]',
        )!
        .click(),
    )
    expect(onAddChild).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
  }
})
