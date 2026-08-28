import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DshWorkspaceTabSurface } from './DshWorkspaceTabSurface'

describe('DshWorkspaceTabSurface', () => {
  beforeEach(() => {
    delete window.__WEWORK_DSH_UI__
  })

  test('attaches the selected DSH workspace slot and updates visibility', () => {
    const update = vi.fn()
    const dispose = vi.fn()
    const attach = vi.fn(() => ({ update, dispose }))
    window.__WEWORK_DSH_UI__ = {
      getEntries: () => [],
      subscribe: () => () => undefined,
      attach,
    }
    const tab = {
      id: 'workspace-1',
      kind: 'auxiliary' as const,
      title: 'Dashboard',
      contentRoute: '/dsh/workspace/dashboard',
      fixed: false,
    }
    const rendered = render(
      <DshWorkspaceTabSurface active path="/dsh/workspace/dashboard" tab={tab} />
    )

    expect(attach).toHaveBeenCalledWith(
      'wework.workspace.tab',
      'dashboard',
      expect.any(HTMLElement),
      {
        tab,
        visible: true,
      }
    )

    rendered.rerender(
      <DshWorkspaceTabSurface active={false} path="/dsh/workspace/dashboard" tab={tab} />
    )
    expect(update).toHaveBeenLastCalledWith({ tab, visible: false })

    rendered.unmount()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
