// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import {
  getDefaultKnowledgeView,
  isKnowledgeView,
  useKnowledgeViewMode,
} from '@/features/knowledge/document/hooks/useKnowledgeViewMode'

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

function setBrowserUrl(path: string) {
  window.history.replaceState({}, '', path)
}

describe('knowledge view mode helpers', () => {
  it('maps kb_type to default opening view', () => {
    expect(getDefaultKnowledgeView('classic')).toBe('documents')
    expect(getDefaultKnowledgeView('notebook')).toBe('notebook')
    expect(getDefaultKnowledgeView(undefined)).toBe('notebook')
    expect(getDefaultKnowledgeView(null)).toBe('notebook')
    expect(getDefaultKnowledgeView('legacy' as never)).toBe('notebook')
  })

  it('accepts only URL view values supported by the page', () => {
    expect(isKnowledgeView('documents')).toBe(true)
    expect(isKnowledgeView('notebook')).toBe(true)
    expect(isKnowledgeView('classic')).toBe(false)
    expect(isKnowledgeView('abc')).toBe(false)
    expect(isKnowledgeView(null)).toBe(false)
  })
})

describe('useKnowledgeViewMode', () => {
  beforeEach(() => {
    setBrowserUrl('/knowledge/default/my-kb')
    jest.restoreAllMocks()
  })

  it('uses a valid URL view before kb_type default view', () => {
    setBrowserUrl('/knowledge/default/my-kb?view=documents')

    const { result } = renderHook(() => useKnowledgeViewMode('notebook'))

    expect(result.current.defaultView).toBe('notebook')
    expect(result.current.currentView).toBe('documents')
  })

  it('falls back to kb_type when URL view is missing', () => {
    const { result } = renderHook(() => useKnowledgeViewMode('classic'))

    expect(result.current.defaultView).toBe('documents')
    expect(result.current.currentView).toBe('documents')
  })

  it('opens notebook view for knowledge task history URLs even when kb_type is classic', () => {
    setBrowserUrl('/knowledge/default/my-kb?taskId=123')

    const { result } = renderHook(() => useKnowledgeViewMode('classic'))

    expect(result.current.defaultView).toBe('documents')
    expect(result.current.currentView).toBe('notebook')
  })

  it('keeps explicit documents view ahead of task history defaults', async () => {
    setBrowserUrl('/knowledge/default/my-kb?view=documents&taskId=123')

    const { result } = renderHook(() => useKnowledgeViewMode('classic'))

    expect(result.current.currentView).toBe('documents')
    await waitFor(() => {
      expect(window.location.search).toBe('?view=documents')
    })
  })

  it('falls back to kb_type when URL view is invalid', () => {
    setBrowserUrl('/knowledge/default/my-kb?view=classic')

    const { result } = renderHook(() => useKnowledgeViewMode('notebook'))

    expect(result.current.currentView).toBe('notebook')
  })

  it('uses the system default when kb_type is missing or invalid', () => {
    const missingKbType = renderHook(() => useKnowledgeViewMode(undefined))
    expect(missingKbType.result.current.currentView).toBe('notebook')

    const invalidKbType = renderHook(() => useKnowledgeViewMode('legacy' as never))
    expect(invalidKbType.result.current.currentView).toBe('notebook')
  })

  it('re-resolves the view when resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ resetKey }) => useKnowledgeViewMode('classic', resetKey),
      { initialProps: { resetKey: 'first' } }
    )

    expect(result.current.currentView).toBe('documents')

    setBrowserUrl('/knowledge/default/my-kb?view=notebook')
    rerender({ resetKey: 'second' })

    expect(result.current.currentView).toBe('notebook')
  })

  it('updates URL with replaceState when switching view', () => {
    setBrowserUrl('/knowledge/default/my-kb?foo=bar#section')
    const replaceStateSpy = jest.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useKnowledgeViewMode('notebook'))

    act(() => {
      result.current.setCurrentView('documents')
    })

    expect(result.current.currentView).toBe('documents')
    expect(replaceStateSpy).toHaveBeenCalledWith(
      {},
      '',
      '/knowledge/default/my-kb?foo=bar&view=documents#section'
    )
  })

  it('removes task params when switching to documents view', () => {
    setBrowserUrl('/knowledge/default/my-kb?view=notebook&taskId=1&task_id=2&taskid=3&foo=bar')
    const { result } = renderHook(() => useKnowledgeViewMode('notebook'))

    act(() => {
      result.current.setCurrentView('documents')
    })

    expect(window.location.search).toBe('?view=documents&foo=bar')
  })

  it('cleans task params on direct documents view entry', async () => {
    setBrowserUrl('/knowledge/default/my-kb?view=documents&taskId=123&foo=bar')
    const replaceStateSpy = jest.spyOn(window.history, 'replaceState')

    const { result } = renderHook(() => useKnowledgeViewMode('notebook'))

    expect(result.current.currentView).toBe('documents')
    await waitFor(() => {
      expect(window.location.search).toBe('?view=documents&foo=bar')
    })
    expect(replaceStateSpy).toHaveBeenCalledWith(
      {},
      '',
      '/knowledge/default/my-kb?view=documents&foo=bar'
    )
  })

  it('does not rewrite URL when documents view has no task params', () => {
    setBrowserUrl('/knowledge/default/my-kb?view=documents&foo=bar')
    const replaceStateSpy = jest.spyOn(window.history, 'replaceState')

    renderHook(() => useKnowledgeViewMode('notebook'))

    expect(replaceStateSpy).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?view=documents&foo=bar')
  })
})
