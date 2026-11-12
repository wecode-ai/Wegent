import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ProjectWithTasks } from '@/types/api'
import { PopoutWorkspaceMenu } from './PopoutWorkspaceMenu'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      ({
        'workbench.popout_workspace_menu': '工作区设置',
        'workbench.popout_workspace_menu_project': '项目',
        'workbench.popout_workspace_menu_no_project': '无项目',
        'workbench.popout_workspace_menu_permission': '权限',
        'workbench.popout_workspace_menu_full_access': '完全访问',
      })[key] ??
      fallback ??
      key,
  }),
}))

const projects = [
  { id: 1, name: 'Wegent' },
  { id: 2, name: 'wework_video' },
] as ProjectWithTasks[]

function renderMenu(overrides: Partial<ComponentProps<typeof PopoutWorkspaceMenu>> = {}) {
  const props: ComponentProps<typeof PopoutWorkspaceMenu> = {
    currentProjectId: 1,
    projectName: 'Wegent',
    projects,
    onSelectProject: vi.fn(),
    ...overrides,
  }
  render(<PopoutWorkspaceMenu {...props} />)
  return props
}

afterEach(() => {
  delete window.__WEWORK_DSH_UI_MODULES__
})

describe('PopoutWorkspaceMenu', () => {
  test('switches projects in the host-owned project submenu', async () => {
    const props = renderMenu()

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-project-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-project-option-2'))

    expect(props.onSelectProject).toHaveBeenCalledWith(2)
    expect(screen.queryByTestId('popout-workspace-menu')).not.toBeInTheDocument()
  })
})
