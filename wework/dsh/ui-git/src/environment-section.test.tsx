import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import {
  WEWORK_HOST_SERVICES,
  type EnvironmentHostService,
} from '@/features/dsh-runtime/conversationHostServices'
import type { ConversationSummarySurfaceProps } from '@/features/dsh-runtime/conversationSummarySurface'
import GitConversationSummary from './environment-section'

function surfaceProps(commands: readonly string[]): ConversationSummarySurfaceProps {
  const environment: EnvironmentHostService = {
    read: () => ({
      devices: [],
      info: {
        additions: '+1',
        branchName: 'develop',
        deletions: '-0',
        executionTarget: 'local',
        isGitRepository: true,
      },
    }),
  }
  return {
    context: { 'workspace.isGitRepository': true },
    docked: true,
    onClose: vi.fn(),
    services: {
      canExecuteCommand: id => commands.includes(id),
      executeCommand: vi.fn(),
      getService: id =>
        id === WEWORK_HOST_SERVICES.environment ? (environment as never) : undefined,
      openResource: vi.fn(),
    },
  }
}

describe('GitConversationSummary', () => {
  test('disables actions whose host commands are unavailable', () => {
    render(<GitConversationSummary {...surfaceProps([])} />)

    expect(screen.getByTestId('environment-changes-button')).toBeDisabled()
    expect(screen.getByTestId('environment-commit-button')).toBeDisabled()
  })

  test('executes only an available commit command', async () => {
    const props = surfaceProps(['git.commit'])
    render(<GitConversationSummary {...props} />)

    await userEvent.click(screen.getByTestId('environment-commit-button'))
    expect(screen.getByTestId('environment-commit-and-push-button')).toBeDisabled()
    expect(screen.getByTestId('environment-push-button')).toBeDisabled()
    await userEvent.type(screen.getByTestId('environment-commit-message-input'), 'Update panel')
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    expect(props.services.executeCommand).toHaveBeenCalledWith('git.commit', {
      message: 'Update panel',
    })
  })
})
