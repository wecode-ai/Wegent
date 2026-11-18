import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import '@/i18n'
import { installDshUiTestContributions } from '@/test/setup.dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import { outputAsRecord, type DeviceCommandApi } from '@/api/environment'
import {
  ChangeRequestMonitor,
  useTaskChangeRequest,
} from '@/features/workbench/changeRequestMonitor'
import { createConnectionObserverFixture } from '@/test/connection-observer'
import type { DeviceCommandResponse, DeviceInfo } from '@/types/api'
import { openSynchronizedChangeRequestSummary } from '../../../e2e/desktop/modules/change-request-observation.mjs'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'
import { applySharedChangeRequestSnapshot } from './useWorkbenchPaneEnvironment'

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

  test('establishes synchronized recovery before the next change-request transition', async () => {
    const reply = createConnectionObserverFixture()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) => {
        const result = reply(request)
        const observation = outputAsRecord(outputAsRecord(result.stdout)?.observation)
        if (observation) observation.refreshPending = false
        return result
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, [
      {
        device_id: 'device',
        runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
      },
    ] as DeviceInfo[])
    const target = linkedChangeRequestTarget('device', 'https://github.com/org/repo/pull/1')!
    const stop = monitor.register(target)
    await monitor.refresh()
    executeCommand.mockRejectedValueOnce(new Error('git_cli_missing'))
    await monitor.refresh({ shareInflight: false })
    stop()

    let completeActivation!: (value: DeviceCommandResponse) => void
    const activation = new Promise<DeviceCommandResponse>(resolve => {
      completeActivation = resolve
    })
    executeCommand.mockImplementationOnce(() => activation)
    function Summary() {
      const [open, setOpen] = useState(false)
      const snapshot = useTaskChangeRequest(monitor, target)!
      return (
        <EnvironmentInfoPopover
          info={applySharedChangeRequestSnapshot(
            { additions: '+0', deletions: '-0', executionTarget: 'local', branchName: 'feature' },
            snapshot
          )}
          docked={false}
          popoverContainer={null}
          open={open}
          onOpenChange={setOpen}
          onRefresh={() => monitor.refresh({ shareInflight: false })}
        />
      )
    }
    const view = render(<Summary />)
    let ready = false
    let waitingForObservation!: () => void
    const observationWait = new Promise<void>(resolve => {
      waitingForObservation = resolve
    })
    const preparation = openSynchronizedChangeRequestSummary({
      async command(action: string, selector: string, options: { text?: string } = {}) {
        if (action === 'click') fireEvent.click(document.querySelector(selector)!)
        else if (action === 'waitFor') {
          if (options.text === '状态同步正常') waitingForObservation()
          await waitFor(() => {
            const element = document.querySelector(selector)
            expect(element).toBeInTheDocument()
            if (options.text) expect(element).toHaveTextContent(options.text)
          })
        } else throw new Error(`Unexpected control action: ${action}`)
        return ''
      },
    }).then(() => {
      ready = true
    })
    try {
      const phase = await Promise.race([
        preparation.then(() => 'prematurely-ready'),
        observationWait.then(() => 'waiting-for-observation'),
      ])
      expect(phase).toBe('waiting-for-observation')
      expect(screen.getByTestId('change-request-button')).toHaveTextContent('#1')
      expect(ready).toBe(false)
      const start = executeCommand.mock.calls.findLast(
        ([, request]) => request.command_key === 'connection_observer_start'
      )![1]
      await act(async () => {
        completeActivation(reply(start))
        await preparation
      })
      expect(ready).toBe(true)
      expect(monitor.getSnapshot(target)?.observation?.state).toBe('observing')
    } finally {
      const start = executeCommand.mock.calls.findLast(
        ([, request]) => request.command_key === 'connection_observer_start'
      )![1]
      completeActivation(reply(start))
      await preparation
      view.unmount()
    }
  })

  test('settles both an in-flight collection and the opening refresh before advancing checks', async () => {
    const reply = createConnectionObserverFixture()
    let checksState = 'FAILURE'
    const collections: Array<{
      response: DeviceCommandResponse
      resolve: (value: DeviceCommandResponse) => void
    }> = []
    const response = (request: Parameters<DeviceCommandApi['executeCommand']>[1]) => {
      const result = reply(request)
      const observation = outputAsRecord(outputAsRecord(result.stdout)?.observation)
      if (observation) {
        observation.refreshPending = false
        observation.resourceStates[0].data.statusCheckRollup = { state: checksState }
      }
      return result
    }
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) => response(request))
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, [
      {
        device_id: 'device',
        runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
      },
    ] as DeviceInfo[])
    const target = linkedChangeRequestTarget('device', 'https://github.com/org/repo/pull/1')!
    const stop = monitor.register(target)
    await monitor.refresh()
    executeCommand.mockImplementation(async (_device, request) => {
      if (request.command_key !== 'connection_observer_refresh') return response(request)
      return new Promise<DeviceCommandResponse>(resolve => {
        collections.push({ response: response(request), resolve })
      })
    })
    const collecting = monitor.refresh({ shareInflight: false })
    function Summary() {
      const [open, setOpen] = useState(false)
      const snapshot = useTaskChangeRequest(monitor, target)!
      return (
        <EnvironmentInfoPopover
          info={applySharedChangeRequestSnapshot(
            { additions: '+0', deletions: '-0', executionTarget: 'local', branchName: 'feature' },
            snapshot
          )}
          docked={false}
          popoverContainer={null}
          open={open}
          onOpenChange={setOpen}
          onRefresh={() => monitor.refresh({ shareInflight: false })}
        />
      )
    }
    const view = render(<Summary />)
    let ready = false
    let waitingForObservation!: () => void
    const observationWait = new Promise<void>(resolve => {
      waitingForObservation = resolve
    })
    const control = {
      async command(action: string, selector: string, options: { text?: string } = {}) {
        if (action === 'click') fireEvent.click(document.querySelector(selector)!)
        else if (action === 'waitFor') {
          if (options.text === '状态同步正常') waitingForObservation()
          await waitFor(() => {
            const element = document.querySelector(selector)
            expect(element).toBeInTheDocument()
            if (options.text) expect(element).toHaveTextContent(options.text)
          })
        } else throw new Error(`Unexpected control action: ${action}`)
        return ''
      },
    }
    const preparation = openSynchronizedChangeRequestSummary(control).then(() => {
      ready = true
    })
    try {
      expect(
        await Promise.race([
          preparation.then(() => 'prematurely-ready'),
          observationWait.then(() => 'waiting-for-observation'),
        ])
      ).toBe('waiting-for-observation')
      expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查失败')
      expect(ready).toBe(false)
      expect(collections).toHaveLength(1)
      await act(async () => {
        collections[0].resolve(collections[0].response)
        await collecting
      })
      expect(collections).toHaveLength(2)
      expect(ready).toBe(false)
      expect(monitor.getSnapshot(target)?.observation?.state).toBe('refreshing')
      await act(async () => {
        collections[1].resolve(collections[1].response)
        await preparation
      })
      expect(ready).toBe(true)
      expect(monitor.getSnapshot(target)?.observation?.state).toBe('observing')
      expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查失败')
      checksState = 'SUCCESS'
      let advanced!: Promise<void>
      act(() => {
        advanced = monitor.refresh({ shareInflight: false })
      })
      expect(collections).toHaveLength(3)
      expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查失败')
      await act(async () => {
        collections[2].resolve(collections[2].response)
        await advanced
      })
      expect(screen.getByTestId('change-request-checks')).toHaveTextContent('检查通过')
      expect(monitor.getSnapshot(target)?.observation?.state).toBe('observing')
    } finally {
      executeCommand.mockImplementation(async (_device, request) => response(request))
      await act(async () => {
        for (const collection of collections) collection.resolve(collection.response)
        await collecting
        await preparation
      })
      view.unmount()
      stop()
    }
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
