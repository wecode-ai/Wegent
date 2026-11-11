import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceTabsContext,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { WeworkCollaborationPlatform } from './WeworkCollaborationPlatform'

const navigation = vi.hoisted(() => ({
  current: null as ((search: string) => void) | null,
  route: '',
  back: undefined as (() => void) | undefined,
  renderProject: undefined as ComponentProps<
    typeof import('@wegent/collaboration').CollaborationPlatformApp
  >['renderProject'],
}))

vi.mock('@/features/collaboration/CollaborationGroupsSurface', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/collaboration/CollaborationGroupsSurface')>()
  return {
    ...actual,
    CollaborationGroupsSurface: (
      props: ComponentProps<typeof actual.CollaborationGroupsSurface>
    ) => {
      navigation.current = props.onNavigate
      navigation.back = props.onBackToBoard
      return <actual.CollaborationGroupsSurface {...props} />
    },
  }
})

vi.mock('@wegent/collaboration', async importOriginal => {
  const actual = await importOriginal<typeof import('@wegent/collaboration')>()
  return {
    ...actual,
    CollaborationPlatformApp: (props: ComponentProps<typeof actual.CollaborationPlatformApp>) => {
      navigation.renderProject = props.renderProject
      return <aside>{props.sidebarHeader}</aside>
    },
  }
})

afterEach(() => {
  navigation.current = null
  navigation.back = undefined
  navigation.renderProject = undefined
  window.history.replaceState({}, '', '/')
})

function fixture(background = false) {
  const owner: WorkspaceTab = {
    id: 'board-owner',
    kind: 'board',
    title: 'Owned collaboration',
    contentRoute: '/todo?collaborationView=groups',
    fixed: false,
  }
  const other: WorkspaceTab = {
    id: 'fixed-task',
    kind: 'task',
    title: 'Task',
    contentRoute: '/',
    fixed: true,
  }
  const active = background ? other : owner
  const context = {
    tabs: [owner, other],
    activeTabId: active.id,
    activeTab: active,
    updateTab: vi.fn(),
    updateActiveTab: vi.fn(),
    selectTab: vi.fn(),
  } as unknown as WorkspaceTabsContextValue
  const services = {
    projectSpaceApis: {
      local: { listCloudProjects: vi.fn().mockResolvedValue({ items: [] }) },
    },
  }
  const view = (userId = 1) => (
    <WorkspaceTabsContext.Provider value={{ ...context, tabs: [...context.tabs] }}>
      <WeworkCollaborationPlatform
        workspaceTabId={owner.id}
        workspaceActive={!background}
        user={{ id: userId, user_name: 'Member', email: 'member@example.com' } as never}
        localProjects={[]}
        services={services as never}
      />
    </WorkspaceTabsContext.Provider>
  )
  return { owner, context, view, services }
}

describe('collaboration navigation ownership', () => {
  it('updates the originating collaboration tab when switching to projects', () => {
    const { owner, context, view } = fixture()
    render(view())
    fireEvent.click(screen.getByRole('button', { name: '项目', exact: true }))
    expect(context.updateTab).toHaveBeenCalledWith(owner.id, {
      contentRoute: '/todo?collaborationView=projects',
    })
    expect(context.selectTab).not.toHaveBeenCalled()
    expect(context.updateActiveTab).not.toHaveBeenCalled()
  })

  it('keeps a background tab independent of global navigation and active-tab callbacks', () => {
    const { owner, context, view } = fixture(true)
    render(view())
    act(() => {
      window.history.replaceState(
        {},
        '',
        '/todo?workspaceTab=fixed-task&collaborationView=projects'
      )
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('button', { name: '协作', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    fireEvent.click(screen.getByRole('button', { name: '项目', exact: true }))
    expect(context.updateTab).toHaveBeenCalledWith(owner.id, {
      contentRoute: '/todo?collaborationView=projects',
    })
    expect(new URLSearchParams(window.location.search).get('workspaceTab')).toBe('fixed-task')
    expect(context.selectTab).not.toHaveBeenCalled()
  })

  it('clears the previous account remembered group destination', () => {
    const { owner, context, view } = fixture()
    owner.contentRoute = '/todo?collaborationView=groups&groupId=previous-account-group'
    const mounted = render(view())
    fireEvent.click(screen.getByRole('button', { name: '项目', exact: true }))
    owner.contentRoute = '/todo?collaborationView=projects'
    mounted.rerender(view(2))
    fireEvent.click(screen.getByRole('button', { name: '协作', exact: true }))
    expect(context.updateTab).toHaveBeenLastCalledWith(owner.id, {
      contentRoute: '/todo?collaborationView=groups',
    })
  })

  it('does not redirect global navigation when its bound tab has closed', () => {
    const { owner, context, view } = fixture(true)
    const mounted = render(view())
    context.tabs = context.tabs.filter(tab => tab.id !== owner.id)
    mounted.rerender(view())
    act(() => {
      window.history.replaceState({}, '', '/?workspaceTab=fixed-task')
      window.dispatchEvent(new PopStateEvent('popstate'))
      navigation.current?.('?collaborationView=projects')
    })
    expect(new URLSearchParams(window.location.search).get('workspaceTab')).toBe('fixed-task')
    expect(context.updateTab).not.toHaveBeenCalled()
    expect(context.selectTab).not.toHaveBeenCalled()
    expect(context.updateActiveTab).not.toHaveBeenCalled()
  })

  it.each(['account change', 'unmount'] as const)(
    'ignores a delayed creation callback after %s',
    async transition => {
      const { context, view } = fixture()
      const mounted = render(view())
      const oldNavigate = navigation.current!
      let finish!: () => void
      const pending = new Promise<void>(resolve => (finish = resolve))
      const completion = pending.then(() =>
        oldNavigate('?collaborationView=groups&groupId=old-result&threadId=old-thread')
      )
      if (transition === 'account change') mounted.rerender(view(2))
      else mounted.unmount()
      await act(async () => {
        finish()
        await completion
      })
      expect(context.updateTab).not.toHaveBeenCalled()
      expect(context.selectTab).not.toHaveBeenCalled()
      expect(window.location.search).not.toContain('old-result')
    }
  )

  it('supports the embedded host without a workspace-tab provider', () => {
    render(
      <WeworkCollaborationPlatform
        user={{ id: 1, user_name: 'Member', email: 'member@example.com' } as never}
        localProjects={[]}
        services={{} as never}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '项目', exact: true }))
    expect(new URLSearchParams(window.location.search).get('collaborationView')).toBe('projects')
  })
})

it('keeps the originating filtered project board when its host opens a Group Thread', async () => {
  const f = fixture()
  const initial =
    '/todo?collaborationView=projects&projectId=project-1&projectStore=local&view=table&search=review'
  const project = {
    id: 'project-1',
    public_id: 'project-1',
    project_store: 'local',
    name: 'Project',
    project_key: 'PRJ',
    task_provider: 'local',
    provider_config: {},
    tags: [],
    status: 'active',
    version: 1,
    created_by_user_id: 1,
    created_at: '',
    updated_at: '',
  }
  f.services.projectSpaceApis.local.listCloudProjects.mockResolvedValue({
    items: [project],
  } as never)
  function ControlledTabs() {
    const [route, setRoute] = useState(initial)
    navigation.route = route
    const owner = { ...f.owner, contentRoute: route }
    return (
      <WorkspaceTabsContext.Provider
        value={{
          ...f.context,
          tabs: [owner],
          activeTab: owner,
          updateTab: (_id, update) => flushSync(() => setRoute(update.contentRoute!)),
        }}
      >
        <WeworkCollaborationPlatform
          workspaceTabId={owner.id}
          user={{ id: 1, user_name: 'Member' } as never}
          localProjects={[]}
          services={f.services as never}
        />
      </WorkspaceTabsContext.Provider>
    )
  }
  render(<ControlledTabs />)
  await waitFor(() => expect(navigation.renderProject).toBeTypeOf('function'))
  const rendered = navigation.renderProject!({
    project,
    workspace: { id: 'workspace', name: 'Workspace' },
  } as never) as ReactElement<{
    onOpenGroupThread(groupId: string, threadId: string, store: 'local'): void
  }>
  const sourceRoute = navigation.route
  act(() => rendered.props.onOpenGroupThread('group-1', 'thread-1', 'local'))
  expect(navigation.back).toBeTypeOf('function')
  act(() => navigation.back!())
  await waitFor(() => expect(screen.getByTestId('wework-collaboration-platform')).toBeVisible())
  expect(navigation.route).toBe(sourceRoute)
})
