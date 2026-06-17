import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { WorkspacePanelActions } from './WorkspacePanelActions'

const baseProps = {
  environmentInfo: {
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local' as const,
  },
  onRefreshEnvironmentInfo: vi.fn(),
  onCommitEnvironmentChanges: vi.fn(),
  onListEnvironmentBranches: vi.fn(),
  onCheckoutEnvironmentBranch: vi.fn(),
  onCreateEnvironmentBranch: vi.fn(),
  onOpenEnvironmentChangesReview: vi.fn(),
  rightPanelOpen: false,
  bottomPanelOpen: false,
  onToggleRightPanel: vi.fn(),
  onToggleBottomPanel: vi.fn(),
}

describe('WorkspacePanelActions', () => {
  test('shows environment info while loading and keeps it when environment context is available', () => {
    const { rerender } = render(<WorkspacePanelActions {...baseProps} />)

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        environmentInfo={{
          ...baseProps.environmentInfo,
          loading: false,
        }}
      />
    )

    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        environmentInfo={{
          ...baseProps.environmentInfo,
          loading: false,
          deviceId: 'device-1',
          workspacePath: '/workspace/project',
        }}
      />
    )

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        environmentInfo={{
          ...baseProps.environmentInfo,
          loading: false,
          branchName: 'main',
        }}
      />
    )

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()
  })
})
