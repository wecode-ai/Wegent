import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'

describe('EnvironmentInfoPopover', () => {
  const portalContainers: HTMLElement[] = []

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
    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
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
          workspacePath: '/workspace/web',
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
    expect(screen.getByTestId('change-request-state')).toHaveTextContent('进行中')
    expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查通过')
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
