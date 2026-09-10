import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
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
  test('renders only host-owned rows when no extension is installed', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))

    const menu = screen.getByTestId('popout-workspace-menu')
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveTextContent('项目')
    expect(menu).toHaveTextContent('Wegent')
    expect(menu).toHaveTextContent('完全访问')
    expect(screen.queryByTestId('popout-workspace-launch-mode-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('popout-workspace-branch-button')).not.toBeInTheDocument()
  })

  test('renders every registered workspace-menu section in contribution order', async () => {
    const entries = [
      { id: 'first', module: 'plugins/test-workspace-first.js' },
      { id: 'second', module: 'plugins/test-workspace-second.js' },
    ]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.workspaceMenuSection ? entries : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }
    window.__WEWORK_DSH_UI_MODULES__ = {
      'plugins/test-workspace-first.js': {
        default: () => <div data-testid="workspace-section-first">first</div>,
      },
      'plugins/test-workspace-second.js': {
        default: () => <div data-testid="workspace-section-second">second</div>,
      },
    }

    renderMenu()
    await userEvent.click(screen.getByTestId('composer-project-menu-button'))

    expect(
      screen
        .getByTestId('workspace-section-first')
        .compareDocumentPosition(screen.getByTestId('workspace-section-second'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('switches projects in the host-owned project submenu', async () => {
    const props = renderMenu()

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-project-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-project-option-2'))

    expect(props.onSelectProject).toHaveBeenCalledWith(2)
    expect(screen.queryByTestId('popout-workspace-menu')).not.toBeInTheDocument()
  })

  test('closes the submenu before closing the menu with Escape', async () => {
    renderMenu()

    const trigger = screen.getByTestId('composer-project-menu-button')
    await userEvent.click(trigger)
    await userEvent.click(screen.getByTestId('popout-workspace-project-button'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('popout-workspace-project-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('popout-workspace-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('popout-workspace-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
