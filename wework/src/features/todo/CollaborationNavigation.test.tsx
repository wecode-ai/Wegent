import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CollaborationPrimaryNavigation,
  CollaborationManagementNavigation,
} from '../../../../packages/collaboration/src/platform/CollaborationPrimaryNavigation'
import { platformMessages } from '../../../../packages/collaboration/src/platform/platformMessages'
import type { CollaborationPlatformHostAdapter } from '@wegent/collaboration/platform'

afterEach(cleanup)

it('navigates three personal scopes without selecting a project and preserves management targets', () => {
  const navigate = vi.fn()
  const host = {
    location: { rootView: 'issues-created', workspaceId: null, projectId: null },
    navigate,
    renderPersonalHome: vi.fn(),
    renderIssueList: vi.fn(),
    createIndependentIssue: vi.fn(),
    templateStore: {},
    templateNavigation: true,
  } as unknown as CollaborationPlatformHostAdapter
  const props = { domain: 'local' as const, host, messages: platformMessages['zh-CN'] }
  render(
    <>
      <CollaborationPrimaryNavigation {...props} />
      <CollaborationManagementNavigation {...props} />
    </>
  )
  for (const scope of ['assigned', 'created', 'participating']) {
    fireEvent.click(screen.getByTestId(`collaboration-primary-issues-${scope}`))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rootView: `issues-${scope}`,
        workspaceId: null,
        projectId: null,
        issueId: null,
      })
    )
  }
  expect(screen.getByTestId('collaboration-primary-issues-created')).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect(screen.queryByTestId('collaboration-primary-stand-in')).not.toBeInTheDocument()
  const group = screen.getByRole('navigation', { name: '协作管理' })
  expect(group.textContent).toMatch(/执行设备模板智能体协作小组/)
  fireEvent.click(screen.getByTestId('collaboration-primary-agents'))
  expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ rootView: 'agents' }))
  fireEvent.click(screen.getByTestId('collaboration-management-toggle'))
  expect(screen.getByTestId('collaboration-management-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  expect(screen.getByTestId('collaboration-primary-agents')).not.toBeVisible()
  fireEvent.click(screen.getByTestId('collaboration-primary-create-issue'))
  expect(host.createIndependentIssue).toHaveBeenCalledOnce()
})
