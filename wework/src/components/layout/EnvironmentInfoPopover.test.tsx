import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { installDshUiTestContributions } from '@/test/setup'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'

describe('EnvironmentInfoPopover', () => {
  const portalContainers: HTMLElement[] = []

  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.environmentSection]: [
          {
            id: 'git-change-request',
            module: 'plugins/wework-ui-git-environment-section.js',
          },
        ],
      },
      {
        'plugins/wework-ui-git-environment-section.js': () =>
          import('../../../dsh/ui-git/src/environment-section'),
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    portalContainers.splice(0).forEach(container => container.remove())
  })

  test('shows the device IP instead of an executor id for offline errors', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'cloud',
          deviceId: '9562a3b4-61a3-4217-9655-0341b231eb06',
          error: 'executor-offline:9562a3b4-61a3-4217-9655-0341b231eb06',
        }}
        devices={[
          {
            id: 1,
            device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
            name: 'sifang-executor-0341b231eb06',
            status: 'offline',
            is_default: false,
            device_type: 'remote',
            client_ip: '10.201.3.200',
          },
        ]}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    const popover = screen.getByTestId('environment-info-popover')
    expect(popover).toHaveTextContent('10.201.3.200 已离线，恢复在线后可继续对话')
    expect(popover).not.toHaveTextContent('executor-offline:')
    expect(popover).not.toHaveTextContent('9562a3b4-61a3-4217-9655-0341b231eb06')
  })

  test('shows the task executor instead of the workspace access device', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'cloud',
          executionDeviceId: 'cloud-device',
          deviceId: 'local-device',
        }}
        devices={[
          {
            id: 1,
            device_id: 'local-device',
            name: 'Local Executor',
            status: 'online',
            is_default: true,
            device_type: 'local',
          },
          {
            id: 2,
            device_id: 'cloud-device',
            name: 'Cloud Verify Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            client_ip: '127.0.0.1',
          },
        ]}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-device-button')).toHaveTextContent('Cloud Verify Device')
    expect(screen.getByTestId('environment-device-button')).not.toHaveTextContent('Local Executor')
  })

  test('delegates open state to the app shell without writing browser storage', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    function ControlledPopover() {
      const [open, setOpen] = useState(true)
      return (
        <EnvironmentInfoPopover
          info={{
            additions: '',
            deletions: '',
            executionTarget: 'local',
          }}
          popoverContainer={popoverContainer}
          open={open}
          onOpenChange={setOpen}
        />
      )
    }

    const first = render(<ControlledPopover />)

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.environmentInfo.open')).toBeNull()

    first.unmount()
    render(<ControlledPopover />)
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.environmentInfo.open')).toBeNull()
  })

  test('shows TODO binding and delivery actions for a local task', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const onDeliver = vi.fn()
    const onManageTodo = vi.fn()

    render(
      <EnvironmentInfoPopover
        info={{ additions: '', deletions: '', executionTarget: 'local' }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onDeliver={onDeliver}
        onManageTodo={onManageTodo}
      />
    )

    expect(screen.getByTestId('environment-todo-binding-button')).toHaveTextContent('关联项目空间')
    expect(screen.getByTestId('environment-delivery-button')).toHaveTextContent('交付到任务…')
    await userEvent.click(screen.getByTestId('environment-todo-binding-button'))
    await userEvent.click(screen.getByTestId('environment-delivery-button'))
    expect(onManageTodo).toHaveBeenCalledOnce()
    expect(onDeliver).toHaveBeenCalledOnce()
  })

  test('shows active supervisor status in the task information popover', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const onConfigureSupervisor = vi.fn()
    const onRunSupervisorNow = vi.fn().mockResolvedValue(null)

    render(
      <EnvironmentInfoPopover
        info={{ additions: '', deletions: '', executionTarget: 'local' }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        supervisor={{
          mode: 'suggest',
          status: 'active',
          instructions: 'Keep the task focused',
          intervalSeconds: 30,
          lastEvaluatedAt: Date.now(),
          suggestions: [],
        }}
        onConfigureSupervisor={onConfigureSupervisor}
        onRunSupervisorNow={onRunSupervisorNow}
      />
    )

    expect(screen.getByTestId('environment-supervisor-section')).toHaveTextContent('监督')
    expect(screen.getByTestId('task-supervisor-status-icon')).toHaveAccessibleName(
      '已检查，无需纠正'
    )
    await userEvent.click(screen.getByTestId('task-supervisor-toggle-button'))
    expect(onConfigureSupervisor).toHaveBeenCalledOnce()
    expect(screen.getByTestId('task-supervisor-status-next-check')).toHaveTextContent('下次巡检')
    await userEvent.click(screen.getByTestId('task-supervisor-status-run-now-button'))
    expect(onRunSupervisorNow).toHaveBeenCalledOnce()
  })

  test('shows every workspace root for a multi-folder project', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: '/workspace/web/',
          workspaceRoots: ['/workspace/web', '/workspace/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('web')
    expect(screen.getByTestId('environment-workspace-root-1')).toHaveTextContent('api')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveAttribute(
      'title',
      '/workspace/api'
    )
    expect(screen.getByTestId('environment-workspace-path-button')).toHaveClass('min-h-11')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveClass('min-h-11')
  })

  test('matches Windows workspace roots with different separators and casing', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: String.raw`C:\Workspace\Web`,
          workspaceRoots: ['C:/workspace/web', 'C:/workspace/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('web')
    expect(screen.getByTestId('environment-workspace-root-1')).toHaveTextContent('api')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveAttribute(
      'title',
      'C:/workspace/api'
    )
  })

  test('matches UNC workspace roots with different separators and casing', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: String.raw`\\SERVER\Share\Web`,
          workspaceRoots: ['//server/share/web', '//server/share/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('web')
    expect(screen.getByTestId('environment-workspace-root-1')).toHaveTextContent('api')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveAttribute(
      'title',
      '//server/share/api'
    )
  })

  test('shows the active worktree path instead of the source project root', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: '/workspace/worktrees/runtime-42/example-project',
          workspaceRoots: ['/workspace/projects/example-project'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('example-project')
    expect(screen.queryByText('/workspace/projects/example-project')).not.toBeInTheDocument()
    expect(screen.queryByTestId('environment-workspace-root-button-1')).not.toBeInTheDocument()
  })

  test('shows the last Windows workspace path segment', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: String.raw`C:\Users\me\worktrees\runtime-42\project`,
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('project')
    expect(screen.getByTestId('environment-workspace-path-button')).toHaveAttribute(
      'title',
      String.raw`C:\Users\me\worktrees\runtime-42\project`
    )
  })

  test('keeps the newest workspace copy confirmation visible for its full duration', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspaceRoots: ['/workspace/web', '/workspace/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('environment-workspace-path-button'))
    })
    expect(
      screen.getByTestId('environment-workspace-path-button').querySelector('[role="status"]')
    ).not.toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('environment-workspace-root-button-1'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })

    expect(
      screen.getByTestId('environment-workspace-root-button-1').querySelector('[role="status"]')
    ).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(
      screen.getByTestId('environment-workspace-root-button-1').querySelector('[role="status"]')
    ).toBeNull()
  })

  test('hides git controls and diff stats for a non-git workspace', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+0',
          deletions: '-0',
          executionTarget: 'local',
          isGitRepository: false,
          workspacePath: '/workspace/plain-project',
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onListBranches={vi.fn().mockResolvedValue([])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
        onOpenChangesReview={vi.fn()}
      />
    )

    expect(screen.queryByTestId('environment-git-section')).not.toBeInTheDocument()
    expect(screen.queryByText('+0')).not.toBeInTheDocument()
    expect(screen.queryByText('-0')).not.toBeInTheDocument()
  })

  test('shows a resolved branch while the rest of the environment is still loading', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          branchName: 'fix/fast-branch-status',
          loading: true,
          branchLoading: false,
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onListBranches={vi.fn().mockResolvedValue([])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(screen.getByTestId('environment-branch-row')).toHaveTextContent('fix/fast-branch-status')
    expect(screen.getByTestId('environment-branch-row')).not.toHaveTextContent('加载中')
  })

  test('renders the pull request associated with the current branch', async () => {
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
          createPullRequestUrl:
            'https://github.com/wecode-ai/Wegent/compare/feature%2Fchange-request-status?expand=1',
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
              checks: 'success',
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

    expect(screen.queryByTestId('create-pull-request-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('change-request-number')).toHaveTextContent('#2631')
    expect(screen.getByTestId('change-request-title')).toHaveTextContent(
      'feat(wework): show pull request status'
    )
    expect(screen.getByTestId('change-request-state')).toHaveTextContent('检查通过，等待合并')
    expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查通过，等待合并')
    expect(
      screen.getByTestId('environment-change-request-status').querySelector('[aria-hidden="true"]')
    ).toHaveClass('text-green-500')
    expect(screen.getByTestId('change-request-pull-request-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('change-request-merged-icon')).not.toBeInTheDocument()
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

  test('shows merge conflicts on the pull request icon without adding a second row', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+2',
          deletions: '-1',
          executionTarget: 'local',
          branchName: 'fix/conflicts',
          changeRequest: {
            provider: 'github',
            state: 'found',
            changeRequest: {
              provider: 'github',
              number: 2692,
              url: 'https://github.com/wecode-ai/Wegent/pull/2692',
              title: 'fix(wework): treat split view',
              state: 'open',
              draft: false,
              checks: 'success',
              mergeability: 'conflicting',
              mergeQueue: 'not_queued',
            },
          },
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    const button = screen.getByTestId('change-request-button')
    expect(button).toHaveClass('h-9')
    expect(screen.getByTestId('change-request-conflict')).toHaveTextContent('存在合并冲突')
    expect(button).toHaveAccessibleName(/存在合并冲突/)
    expect(
      screen.getByTestId('environment-change-request-status').querySelector('[aria-hidden="true"]')
    ).toHaveClass('text-red-500')
  })

  test('shows a pending status while the pull request is in the merge queue', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+2',
          deletions: '-1',
          executionTarget: 'local',
          branchName: 'fix/merge-queue-status',
          changeRequest: {
            provider: 'github',
            state: 'found',
            changeRequest: {
              provider: 'github',
              number: 2779,
              url: 'https://github.com/wecode-ai/Wegent/pull/2779',
              title: 'fix(wework): stabilize paused streaming scroll',
              state: 'open',
              draft: false,
              checks: 'success',
              mergeability: 'mergeable',
              mergeQueue: 'queued',
            },
          },
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    const button = screen.getByTestId('change-request-button')
    expect(screen.getByTestId('change-request-merge-queue')).toHaveTextContent('Merge Queue 排队中')
    expect(screen.queryByTestId('change-request-checks')).not.toBeInTheDocument()
    expect(button).toHaveAccessibleName(/Merge Queue 排队中/)
    expect(button).not.toHaveAccessibleName(/检查通过/)
    expect(
      screen.getByTestId('environment-change-request-status').querySelector('[aria-hidden="true"]')
    ).not.toHaveClass('text-green-500')
  })

  test('shows a purple icon for a merged pull request', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+0',
          deletions: '-0',
          executionTarget: 'local',
          branchName: 'feature/merged-change-request',
          changeRequest: {
            provider: 'github',
            state: 'found',
            changeRequest: {
              provider: 'github',
              number: 2780,
              url: 'https://github.com/wecode-ai/Wegent/pull/2780',
              title: 'feat(wework): merged change request',
              state: 'merged',
              draft: false,
              checks: 'success',
              mergeability: 'unknown',
              mergeQueue: 'not_queued',
            },
          },
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    const icon = screen
      .getByTestId('environment-change-request-status')
      .querySelector('[aria-hidden="true"]')
    expect(screen.getByTestId('change-request-state')).toHaveTextContent('已合并')
    expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查通过')
    expect(icon).toHaveClass('text-violet-500')
    expect(icon).not.toHaveClass('text-green-500')
    expect(screen.getByTestId('change-request-merged-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('change-request-pull-request-icon')).not.toBeInTheDocument()
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

  test('renders no source-control section when no environment contribution is installed', () => {
    const defaultRuntime = window.__WEWORK_DSH_UI__
    window.__WEWORK_DSH_UI__ = {
      ...defaultRuntime!,
      getEntries: slot =>
        slot === 'wework.environment.section'
          ? []
          : (defaultRuntime?.getEntries(slot as never) ?? []),
    }
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    try {
      render(
        <EnvironmentInfoPopover
          info={{
            additions: '+2',
            branchName: 'feature/example',
            deletions: '-1',
            executionTarget: 'local',
            isGitRepository: true,
          }}
          popoverContainer={popoverContainer}
          open
          onOpenChange={vi.fn()}
          onCommitChanges={vi.fn()}
          onListBranches={vi.fn()}
          onCheckoutBranch={vi.fn()}
          onOpenChangesReview={vi.fn()}
        />
      )

      expect(screen.queryByTestId('environment-git-section')).not.toBeInTheDocument()
      expect(screen.queryByTestId('environment-changes-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('environment-commit-button')).not.toBeInTheDocument()
    } finally {
      window.__WEWORK_DSH_UI__ = defaultRuntime
    }
  })
})
