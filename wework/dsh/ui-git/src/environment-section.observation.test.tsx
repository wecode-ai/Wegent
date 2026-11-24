import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ConversationSummarySurfaceProps } from '@/features/dsh-runtime/conversationSummarySurface'
import type { EnvironmentInfo } from '@/types/environment'
import GitConversationSummary from './environment-section'

it('loads branches when the environment picker opens without refreshing the environment', async () => {
  const info: EnvironmentInfo = {
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local',
    isGitRepository: true,
  }
  const executeCommand = vi.fn(async (id: string) => {
    if (id === 'git.list-branches') return ['main']
  })
  const services = {
    getService: () => ({ read: () => ({ info }) }),
    canExecuteCommand: () => true,
    executeCommand,
  } as unknown as ConversationSummarySurfaceProps['services']

  render(<GitConversationSummary context={{}} services={services} />)
  await userEvent.click(screen.getByTestId('environment-branch-row'))

  expect(await screen.findByTestId('environment-branch-option')).toHaveTextContent('main')
  expect(executeCommand.mock.calls.map(([id]) => id)).toEqual(['git.list-branches'])
})

function fixture(state: 'observing' | 'refreshing' | 'auth_required' | 'error', error?: string) {
  const info: EnvironmentInfo = {
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local',
    branchName: 'feature/events',
    changeRequest: {
      provider: 'github',
      state: 'found',
      changeRequest: {
        provider: 'github',
        number: 48,
        url: 'https://github.com/org/repo/pull/48',
        title: 'Fix CI',
        state: 'open',
        checks: 'failure',
        draft: false,
        mergeability: 'unknown',
        mergeQueue: 'not_queued',
      },
    },
    changeRequestObservation: {
      state,
      transport: 'connection',
      lastSuccessAt: 1,
      stale: state === 'auth_required' || state === 'error',
      error,
    },
  }
  const services = {
    getService: () => ({ read: () => ({ info }) }),
    canExecuteCommand: () => false,
  } as unknown as ConversationSummarySurfaceProps['services']
  return render(<GitConversationSummary context={{}} services={services} />)
}

describe('Git environment shared observation status', () => {
  it('retains the PR and exposes the missing CLI recovery hint', () => {
    fixture('error', 'git_cli_missing')
    expect(screen.getByTestId('change-request-button')).toHaveTextContent('#48')
    expect(screen.getByTestId('change-request-lookup-hint')).toHaveTextContent(
      /安装 GitHub CLI|Install GitHub CLI/i
    )
    expect(screen.getByTestId('change-request-open-settings')).toBeVisible()
    expect(screen.getByTestId('environment-change-request-stale')).toHaveTextContent(
      /状态可能已过期|Status may be stale/i
    )
  })

  it.each([
    ['refreshing', /正在同步状态|Syncing status/i],
    ['auth_required', /连接需要重新授权|Connection needs authorization/i],
    ['error', /状态同步异常|Status synchronization failed/i],
  ] as const)('shows %s without hiding the last PR state', (state, label) => {
    fixture(state)
    expect(screen.getByTestId('change-request-button')).toHaveTextContent('#48')
    expect(screen.getByTestId('environment-change-request-observation')).toHaveTextContent(label)
    if (state === 'auth_required' || state === 'error')
      expect(screen.getByTestId('change-request-open-settings')).toBeVisible()
    else expect(screen.queryByTestId('change-request-open-settings')).not.toBeInTheDocument()
  })

  it('passes collection health into the PR status popover', async () => {
    fixture('auth_required')
    await userEvent.click(screen.getByTestId('environment-change-request-status'))
    expect(screen.getByTestId('environment-change-request-status-popover')).toHaveTextContent(
      /连接需要重新授权|Connection needs authorization/i
    )
    expect(screen.getByTestId('environment-change-request-status-popover')).toHaveTextContent(
      /过期|outdated/i
    )
  })

  it('keeps healthy synchronization out of the compact environment row', () => {
    fixture('observing')
    expect(screen.queryByTestId('environment-change-request-observation')).not.toBeInTheDocument()
    expect(screen.getByTestId('change-request-button')).toHaveTextContent('#48')
  })
})
