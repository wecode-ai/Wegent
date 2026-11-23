// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchableSelect } from '../controls/SearchableSelect'
import { CollaborationTheme } from '../theme'

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
