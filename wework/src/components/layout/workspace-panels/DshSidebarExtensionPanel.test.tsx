import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { DshSidebarExtensionPanel } from './DshSidebarExtensionPanel'

vi.mock('@/components/topnav/AppIframe', () => ({
  AppIframe: (props: Record<string, unknown>) => (
    <div
      data-testid="workspace-sidebar-iframe"
      data-active={String(props.active)}
      data-app-key={String(props.appKey)}
      data-browser-label={String(props.embeddedBrowserLabel)}
      data-src={String(props.src)}
      data-title={String(props.title)}
      data-workspace-tab-id={String(props.workspaceTabId)}
    />
  ),
}))

vi.mock('@/features/dsh-runtime/DshSlotSurface', () => ({
  DshSlotSurface: ({ entryId }: { entryId: string }) => (
    <div data-testid="workspace-sidebar-component">{entryId}</div>
  ),
}))

describe('DshSidebarExtensionPanel', () => {
  const scope = { sessionId: 'session-1', cwd: '/workspace/example' }
  const tab = {
    id: 'reference-website',
    type: 'reference-website',
    title: 'Reference website',
  }

  test('renders descriptor-only iframe tabs through the managed app browser surface', () => {
    render(
      <DshSidebarExtensionPanel
        descriptor={{
          id: 'reference-website',
          mode: 'iframe',
          title: 'Reference website',
          url: 'https://example.com/',
        }}
        scope={scope}
        tab={tab}
        visible
      />
    )

    expect(screen.getByTestId('workspace-sidebar-iframe')).toHaveAttribute(
      'data-src',
      'https://example.com/'
    )
    expect(screen.getByTestId('workspace-sidebar-iframe')).toHaveAttribute(
      'data-app-key',
      'workspace-sidebar-reference-website'
    )
    expect(screen.getByTestId('workspace-sidebar-iframe')).toHaveAttribute(
      'data-workspace-tab-id',
      'reference-website'
    )
    expect(screen.getByTestId('workspace-sidebar-iframe')).toHaveAttribute(
      'data-browser-label',
      'workspace-sidebar:session-1:reference-website'
    )
  })

  test('keeps component-backed sidebar tabs on the native DSH slot path', () => {
    render(
      <DshSidebarExtensionPanel
        descriptor={{ id: 'inspector', title: 'Inspector' }}
        scope={scope}
        tab={{ ...tab, id: 'inspector', type: 'inspector', title: 'Inspector' }}
        visible
      />
    )

    expect(screen.getByTestId('workspace-sidebar-component')).toHaveTextContent('inspector')
    expect(screen.queryByTestId('workspace-sidebar-iframe')).not.toBeInTheDocument()
  })
})
