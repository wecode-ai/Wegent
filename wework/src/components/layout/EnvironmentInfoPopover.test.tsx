import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import '@/i18n'
import { installDshUiTestContributions } from '@/test/setup.dom'
import { render, screen } from '@testing-library/react'
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
})
