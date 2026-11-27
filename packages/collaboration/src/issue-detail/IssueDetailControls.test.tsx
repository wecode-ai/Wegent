// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchableSelect, type SearchableSelectOption } from '../controls/SearchableSelect'
import { createCollaborationTranslator } from '../i18n'
import { CollaborationTheme } from '../theme'
import type { CollaborationIssue, SharedIssueAssignmentHistoryEntry } from '../types'
import type { IssueAssigneeTarget } from './IssueDetailDraft'
import {
  isValidIssueAssignmentShortcut,
  issueAssignmentOptions,
  issueAssignmentShortcuts,
} from './issueAssignmentShortcuts'

describe('Issue assignment suggestions', () => {
  const translate = createCollaborationTranslator('en')
  const candidates: SearchableSelectOption<IssueAssigneeTarget>[] = [
    { value: '', label: 'Unassigned' },
    ...Array.from({ length: 7 }, (_, index) => ({
      value: `user:${index + 1}` as const,
      label: `Member ${index + 1}`,
      group: 'Member',
      testId: `person-${index + 1}`,
      disabled: index === 6,
    })),
    { value: 'agent:historical', label: 'Agent', group: 'Agents' },
  ]
  const baseIssue: CollaborationIssue = {
    id: 'issue-1',
    cloud_project_id: 'project-1',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: 1,
    title: 'Review handoff',
    description: '',
    status: 'open',
    priority: 'none',
    due_at: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: '2026-11-27T00:00:00Z',
    updated_at: '2026-11-27T00:00:00Z',
    completed_at: null,
  }

  function history(...targets: (number | 'agent' | null)[]): SharedIssueAssignmentHistoryEntry[] {
    return targets.map((target, index) => ({
      by_user_id: 1,
      to_type: target === 'agent' ? 'agent' : target === null ? null : 'user',
      to_id: target === 'agent' ? 'historical' : target === null ? null : String(target),
      action: target === null ? 'unassign' : 'assign',
      at: new Date(Date.UTC(2026, 10, 27, 0, index)).toISOString(),
    }))
  }

  const issue = {
    ...baseIssue,
    assignment_history: history(6, 5, 4, 3, 'agent', 7, 8, 3, 2, null, 1, 1),
  }

  it('selects the previous assignee and at most three further eligible people in recency order', () => {
    const shortcuts = issueAssignmentShortcuts(issue, candidates, 'Member 1', true, translate)
    expect(shortcuts.map(({ kind, target }) => [kind, target])).toEqual([
      ['redeliver', 'user:1'],
      ['return', 'user:2'],
      ['recent', 'user:3'],
      ['recent', 'user:4'],
      ['recent', 'user:5'],
    ])
  })

  it.each([7, 8])('does not replace an unavailable previous assignee (%s)', previous => {
    const shortcuts = issueAssignmentShortcuts(
      { ...baseIssue, assignment_history: history(2, previous, 1) },
      candidates,
      'Member 1',
      true,
      translate
    )
    expect(shortcuts.map(({ kind, target }) => [kind, target])).toEqual([
      ['redeliver', 'user:1'],
      ['recent', 'user:2'],
    ])
  })

  it.each([true, false])(
    'groups ordinary choices without duplicates (namespaced=%s)',
    namespaced => {
      const shortcuts = issueAssignmentShortcuts(issue, candidates, 'Member 1', true, translate)
      const options = issueAssignmentOptions(
        shortcuts,
        candidates.map(candidate => ({
          ...candidate,
          value: namespaced ? candidate.value : candidate.value.replace(/^user:/, ''),
        })),
        'assignee',
        translate
      )
      const value = (id: number) => (namespaced ? `user:${id}` : String(id))
      expect(options.map(option => option.value)).toEqual([
        'redeliver:user:1',
        'return:user:2',
        value(3),
        value(4),
        value(5),
        '',
        value(1),
        value(2),
        value(6),
        value(7),
        'agent:historical',
      ])
      expect(options.filter(option => option.section === 'Recent transfers')).toEqual(
        [3, 4, 5].map(id =>
          expect.objectContaining({
            value: value(id),
            label: `Member ${id}`,
            testId: `person-${id}`,
          })
        )
      )
      expect(new Set(options.map(option => option.value)).size).toBe(options.length)
    }
  )

  it('keeps the original choices when no assignment history is available', () => {
    const shortcuts = issueAssignmentShortcuts(baseIssue, candidates, 'Member 1', false, translate)
    expect(shortcuts).toEqual([])
    expect(issueAssignmentOptions(shortcuts, candidates, 'assignee', translate)).toEqual(candidates)
  })

  it('invalidates a return shortcut after intermediate transfers while allowing same-person redelivery', () => {
    const initial = { ...baseIssue, assignee_user_id: 2, assignment_history: history(1, 2) }
    const returnShortcut = issueAssignmentShortcuts(
      initial,
      candidates,
      'Member 2',
      true,
      translate
    ).find(shortcut => shortcut.kind === 'return')!
    expect(isValidIssueAssignmentShortcut(initial, returnShortcut)).toBe(true)
    expect(
      isValidIssueAssignmentShortcut(
        { ...initial, assignment_history: history(1, 2, 2) },
        returnShortcut
      )
    ).toBe(true)
    for (const stale of [
      { ...initial, assignee_user_id: 3, assignment_history: history(1, 2, 3) },
      { ...initial, assignee_user_id: 2, assignment_history: history(1, 2, 3, 2) },
      { ...initial, assignee_user_id: 2, assignment_history: history(1, 2, 1, 2) },
      { ...initial, assignee_user_id: null, assignment_history: history(1, 2, null) },
    ]) {
      expect(isValidIssueAssignmentShortcut(stale, returnShortcut)).toBe(false)
    }
  })
})

describe('SearchableSelect', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderSelect() {
    await act(async () => {
      root.render(
        <CollaborationTheme mode="light">
          <SearchableSelect
            value=""
            testId="assignee"
            accessibleLabel="负责人"
            className="trigger"
            triggerContent="未指派"
            searchPlaceholder="搜索负责人"
            emptyLabel="没有匹配的负责人"
            groupLimit={3}
            showAllLabel={(_group, count) => `查看全部 ${count} 个`}
            options={[
              { value: '', label: '未指派' },
              ...Array.from({ length: 7 }, (_, index) => ({
                value: `group:${index + 1}`,
                label: `协作小组 ${index + 1}`,
                group: '协作小组',
              })),
              { value: 'user:1', label: '我', group: '成员' },
            ]}
            onChange={vi.fn()}
          />
        </CollaborationTheme>
      )
    })
  }

  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  async function change(element: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    await act(async () => {
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  function portalByTestId(testId: string) {
    return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  }

  it('renders the selected label once while keeping its accessible description', async () => {
    await renderSelect()
    const trigger = container.querySelector('[data-testid="assignee"]')!
    expect(trigger.textContent?.trim()).toBe('未指派')
    expect(trigger.getAttribute('title')).toBe('未指派')
  })

  it('limits large groups and expands them without hiding other sections', async () => {
    await renderSelect()
    await click(container.querySelector('[data-testid="assignee"]')!)

    expect(portalByTestId('assignee-option-group:1')).not.toBeNull()
    expect(portalByTestId('assignee-option-group:3')).not.toBeNull()
    expect(portalByTestId('assignee-option-group:4')).toBeNull()
    expect(portalByTestId('assignee-option-user:1')).not.toBeNull()

    await click(portalByTestId('assignee-show-all-协作小组')!)

    expect(portalByTestId('assignee-option-group:7')).not.toBeNull()
    expect(portalByTestId('assignee-show-all-协作小组')).toBeNull()
  })

  it('searches all candidates even when their group is initially limited', async () => {
    await renderSelect()
    await click(container.querySelector('[data-testid="assignee"]')!)

    await change(portalByTestId('assignee-search') as HTMLInputElement, '协作小组 7')

    expect(portalByTestId('assignee-option-group:7')).not.toBeNull()
    expect(portalByTestId('assignee-option-group:1')).toBeNull()
    expect(portalByTestId('assignee-show-all-协作小组')).toBeNull()
  })

  it('supports option arrows and boundaries while preserving search caret keys and preventing submission', async () => {
    await renderSelect()
    await click(container.querySelector('[data-testid="assignee"]')!)
    const search = portalByTestId('assignee-search')!
    expect(document.activeElement).toBe(search)
    const press = async (target: Element, key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => {
        target.dispatchEvent(event)
      })
      return event
    }
    expect((await press(search, 'Home')).defaultPrevented).toBe(false)
    expect((await press(search, 'Enter')).defaultPrevented).toBe(true)
    const active = () => document.getElementById(search.getAttribute('aria-activedescendant') ?? '')
    await press(search, 'ArrowDown')
    expect(document.activeElement).toBe(search)
    expect(active()).toBe(portalByTestId('assignee-option-empty'))
    expect((await press(search, 'End')).defaultPrevented).toBe(false)
    expect((await press(search, 'Home')).defaultPrevented).toBe(false)
    expect(active()).toBe(portalByTestId('assignee-option-empty'))
    await press(search, 'ArrowUp')
    expect(active()).toBe(portalByTestId('assignee-option-user:1'))
    await press(search, 'ArrowDown')
    expect(active()).toBe(portalByTestId('assignee-option-empty'))
    expect(document.activeElement).toBe(search)
    expect(document.querySelectorAll('[role="option"][tabindex="0"]')).toHaveLength(0)
  })

  it.each([
    ['ArrowDown', true, 0],
    ['ArrowUp', true, 0],
    ['Enter', true, 0],
    ['Escape', true, 0],
    ['ArrowDown', false, 229],
    ['ArrowUp', false, 229],
    ['Enter', false, 229],
    ['Escape', false, 229],
  ] as const)(
    'keeps composing %s inside search (isComposing=%s)',
    async (key, isComposing, keyCode) => {
      await renderSelect()
      await click(container.querySelector('[data-testid="assignee"]')!)
      const search = portalByTestId('assignee-search')!
      const event = new KeyboardEvent('keydown', {
        key,
        isComposing,
        keyCode,
        bubbles: true,
        cancelable: true,
      })
      await act(async () => {
        search.dispatchEvent(event)
      })
      expect(portalByTestId('assignee-menu')).not.toBeNull()
      expect(document.activeElement).toBe(search)
      if (key !== 'Escape') expect(event.defaultPrevented).toBe(false)
    }
  )
})
