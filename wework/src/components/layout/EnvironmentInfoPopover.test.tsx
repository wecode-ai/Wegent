import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import '@/i18n'
import { installDshUiTestContributions } from '@/test/setup.dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'

describe('EnvironmentInfoPopover', () => {
  const portalContainers: HTMLElement[] = []

  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.conversationSummary]: [
          {
            id: 'git-summary',
            module: 'plugins/wework-ui-git-environment-section.js',
            requiredHostServices: ['wework.environment'],
            when: { key: 'workspace.isGitRepository', equals: true },
          },
          {
            id: 'outputs-summary',
            module: 'plugins/wework-ui-outputs-conversation-summary.js',
            requiredHostServices: ['wework.conversation.outputs'],
            when: { key: 'workspace.isGitRepository', equals: false },
          },
        ],
      },
      {
        'plugins/wework-ui-git-environment-section.js': () =>
          import('../../../dsh/ui-git/src/environment-section'),
        'plugins/wework-ui-outputs-conversation-summary.js': () =>
          import('../../../dsh/ui-outputs/src/conversation-summary'),
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    portalContainers.splice(0).forEach(container => container.remove())
  })

  test('opens the shared pull request status control from the environment panel', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+2',
          deletions: '-1',
          executionTarget: 'local',
          branchName: 'feature/change-request-status',
          changeRequest: {
            provider: 'github',
            state: 'found',
            changeRequest: {
              provider: 'github',
              number: 2631,
              url: 'https://github.com/wecode-ai/Wegent/pull/2631',
              title: 'feat(wework): show pull request status',
              state: 'open',
              draft: false,
              checks: 'failure',
              mergeability: 'mergeable',
              mergeQueue: 'not_queued',
            },
          },
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('environment-change-request-status'))

    expect(screen.getByTestId('environment-change-request-status-popover')).toBeInTheDocument()
    expect(screen.getByTestId('environment-change-request-status-open')).toHaveTextContent(
      '打开 PR'
    )
  })

  test('opens Git hosting settings from a GitLab CLI recovery hint', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const onOpenChange = vi.fn()

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+0',
          deletions: '-0',
          executionTarget: 'local',
          branchName: 'feature/change-request-status',
          createPullRequestUrl:
            'https://gitlab.com/wecode-ai/Wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fchange-request-status',
          changeRequest: {
            provider: 'gitlab',
            state: 'unavailable',
          },
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={onOpenChange}
      />
    )

    expect(screen.getByTestId('create-pull-request-button')).toBeEnabled()
    expect(screen.getByTestId('create-pull-request-button')).toHaveTextContent('创建合并请求')
    expect(screen.getByTestId('change-request-lookup-hint')).toHaveTextContent(
      '安装 GitLab CLI（glab）后可查询合并请求状态'
    )
    await userEvent.click(screen.getByTestId('change-request-open-settings'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(window.location.pathname).toBe('/settings/git-hosting')
  })

  describe('commit feedback', () => {
    async function renderCommitPanel(onCommitAndPushChanges: (message: string) => Promise<void>) {
      const popoverContainer = document.createElement('div')
      document.body.appendChild(popoverContainer)
      portalContainers.push(popoverContainer)
      const view = render(
        <EnvironmentInfoPopover
          info={{ additions: '+1', deletions: '-0', executionTarget: 'local', branchName: 'main' }}
          popoverContainer={popoverContainer}
          open
          onOpenChange={vi.fn()}
          onCommitAndPushChanges={onCommitAndPushChanges}
        />
      )
      await screen.findByTestId('environment-commit-button')
      vi.useFakeTimers()
      return view
    }

    async function submitCommit(message: string) {
      fireEvent.click(screen.getByTestId('environment-commit-button'))
      fireEvent.change(screen.getByTestId('environment-commit-message-input'), {
        target: { value: message },
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('environment-commit-and-push-button'))
      })
    }

    test('keeps the next commit pending beyond the previous success deadline', async () => {
      let completeSecond!: () => void
      const secondCommit = new Promise<void>(resolve => {
        completeSecond = resolve
      })
      const commit = vi
        .fn<(message: string) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(secondCommit)
      await renderCommitPanel(commit)
      await submitCommit('test: first')
      expect(screen.getByTestId('environment-commit-button')).toHaveTextContent('已提交')
      await act(async () => vi.advanceTimersByTimeAsync(1500))

      await submitCommit('test: second')
      await act(async () => vi.advanceTimersByTimeAsync(101))
      expect(screen.getByTestId('environment-commit-progress-row')).toHaveTextContent(
        '正在提交并推送'
      )
      expect(screen.queryByTestId('environment-commit-button')).not.toBeInTheDocument()
      expect(commit).toHaveBeenCalledTimes(2)

      await act(async () => completeSecond())
      expect(screen.getByTestId('environment-commit-button')).toHaveTextContent('已提交')
      await act(async () => vi.advanceTimersByTimeAsync(1599))
      expect(screen.getByTestId('environment-commit-button')).toHaveTextContent('已提交')
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(screen.getByTestId('environment-commit-button')).not.toHaveTextContent('已提交')
    })

    test('gives explicit recovery a full success period after generation fails', async () => {
      const commit = vi
        .fn<(message: string) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('提交失败'))
        .mockResolvedValueOnce(undefined)
      await renderCommitPanel(commit)
      await submitCommit('')
      await act(async () => vi.advanceTimersByTimeAsync(400))
      await submitCommit('')
      expect(screen.getByTestId('environment-info-popover')).toHaveTextContent('提交失败')
      await act(async () => vi.advanceTimersByTimeAsync(1100))

      await submitCommit('test: recover with explicit message')
      expect(commit.mock.calls).toEqual([[''], [''], ['test: recover with explicit message']])
      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(screen.getByTestId('environment-commit-button')).toHaveTextContent('已提交')
      await act(async () => vi.advanceTimersByTimeAsync(1499))
      expect(screen.getByTestId('environment-commit-button')).toHaveTextContent('已提交')
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(screen.getByTestId('environment-commit-button')).not.toHaveTextContent('已提交')
    })

    test('leaves no feedback timer after the summary unmounts', async () => {
      const view = await renderCommitPanel(vi.fn().mockResolvedValue(undefined))
      await submitCommit('test: finish before closing')
      expect(screen.getByTestId('environment-commit-button')).toHaveTextContent('已提交')

      view.unmount()
      await act(async () => vi.advanceTimersByTimeAsync(0))

      expect(vi.getTimerCount()).toBe(0)
    })

    test('does not schedule feedback when a pending commit finishes after unmount', async () => {
      let completeCommit!: () => void
      const pendingCommit = new Promise<void>(resolve => {
        completeCommit = resolve
      })
      const commit = vi.fn<(message: string) => Promise<void>>().mockReturnValue(pendingCommit)
      const view = await renderCommitPanel(commit)
      await submitCommit('test: finish after closing')
      expect(screen.getByTestId('environment-commit-progress-row')).toBeInTheDocument()

      view.unmount()
      await act(async () => completeCommit())
      await act(async () => vi.advanceTimersByTimeAsync(0))

      expect(commit).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
