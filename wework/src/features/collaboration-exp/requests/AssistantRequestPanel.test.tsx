import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantExecutionRequest, AssistantRequestsApi } from '@wegent/collaboration'
import '@/i18n'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { AssistantRequestPanel } from './AssistantRequestPanel'
import { clearAssistantRequestScopesForTests } from './assistantRequestScopeStore'

const account = vi.hoisted(() => ({ user: { id: 7 }, backend: 'backend-one' }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: { user: account.user } }),
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useCloudConnection: () => ({ backend: account.backend }),
}))
vi.mock('@/features/workbench/workbenchOwnership', () => ({
  workbenchOwnershipKey: () => `${account.backend}:${account.user.id}`,
}))

afterEach(() => {
  cleanup()
  clearAssistantRequestScopesForTests()
  account.user = { id: 7 }
  account.backend = 'backend-one'
})

function request(overrides: Partial<AssistantExecutionRequest> = {}): AssistantExecutionRequest {
  return {
    requestId: 'req-a',
    parentRequestId: null,
    ownerUserId: 7,
    deviceId: 'device',
    runtimeTaskId: 'assistant-request-req-a',
    conversationId: 'assistant-request-req-a',
    executionId: '11',
    state: 'running',
    queuePosition: null,
    reasonCode: null,
    updatedAt: '2026-11-17T00:00:00Z',
    message: 'Private request A',
    commands: [],
    ...overrides,
  }
}

function fixture(api?: AssistantRequestsApi) {
  return {
    project: experienceProjectFixture({ project_store: 'backend', current_user_id: 7 }),
    issue: experienceIssueFixture({
      assignee_user_id: 7,
    }),
    active: true,
    revision: 0,
    onExecution: vi.fn(),
    api: api ?? {
      list: vi.fn().mockResolvedValue({ enabled: true, requests: [request()] }),
      submit: vi.fn().mockResolvedValue(request()),
      confirmMerge: vi.fn().mockResolvedValue(request()),
    },
  }
}

describe('explicit assistant requests', () => {
  it('admits a message and clears only its draft before server acceptance settles', async () => {
    const props = fixture()
    let accept!: (value: AssistantExecutionRequest) => void
    const pending = new Promise<AssistantExecutionRequest>(resolve => {
      accept = resolve
    })
    vi.mocked(props.api.submit).mockReturnValueOnce(pending)
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Independent B' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    try {
      expect(screen.getByTestId('assistant-request-message')).toHaveValue('')
      expect(screen.getByTestId('assistant-request-message')).toBeEnabled()
      expect(props.api.submit).not.toHaveBeenCalled()
      expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent(
        'Independent B'
      )
      fireEvent.change(screen.getByTestId('assistant-request-message'), {
        target: { value: 'My next draft' },
      })
    } finally {
      await act(async () => accept(request({ requestId: 'req-b', message: 'Independent B' })))
    }
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('My next draft')
  })

  it('separates new requests from followups and opens the returned execution', async () => {
    const props = fixture()
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-continue-req-a'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'More for A' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    await waitFor(() =>
      expect(props.api.submit).toHaveBeenCalledWith(
        props.project.id,
        props.issue.id,
        expect.objectContaining({ action: 'followup', requestId: 'req-a', message: 'More for A' })
      )
    )
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Independent B' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    await waitFor(() =>
      expect(props.api.submit).toHaveBeenLastCalledWith(
        props.project.id,
        props.issue.id,
        expect.objectContaining({ action: 'new_request', message: 'Independent B' })
      )
    )
    expect(vi.mocked(props.api.submit).mock.calls[1][2]).not.toHaveProperty('requestId')
    fireEvent.click(screen.getByTestId('assistant-request-open-req-a'))
    expect(props.onExecution).toHaveBeenCalledWith({
      deviceId: 'device',
      taskId: 'assistant-request-req-a',
    })
  })

  it('sends an independent request while the first acceptance is pending', async () => {
    const props = fixture()
    let accept!: (value: AssistantExecutionRequest) => void
    const pending = new Promise<AssistantExecutionRequest>(resolve => {
      accept = resolve
    })
    vi.mocked(props.api.submit).mockReturnValueOnce(pending)
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    for (const message of ['First', 'Independent']) {
      fireEvent.change(screen.getByTestId('assistant-request-message'), {
        target: { value: message },
      })
      fireEvent.click(screen.getByTestId('assistant-request-send'))
      expect(screen.getByTestId('assistant-request-message')).toBeEnabled()
    }
    try {
      await waitFor(() => expect(props.api.submit).toHaveBeenCalledTimes(2))
      expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent('First')
      expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent(
        'Independent'
      )
      const calls = vi.mocked(props.api.submit).mock.calls
      expect(calls[0][2].idempotencyKey).not.toBe(calls[1][2].idempotencyKey)
    } finally {
      await act(async () => accept(request()))
    }
  })

  it('restores admitted messages and newer drafts after unmount without sending them twice', async () => {
    const props = fixture()
    let accept!: (value: AssistantExecutionRequest) => void
    const pending = new Promise<AssistantExecutionRequest>(resolve => {
      accept = resolve
    })
    vi.mocked(props.api.submit).mockReturnValueOnce(pending)
    const first = render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Admitted' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Next draft' },
    })
    await waitFor(() => expect(props.api.submit).toHaveBeenCalledTimes(1))
    first.unmount()
    render(<AssistantRequestPanel {...props} />)
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('Next draft')
    expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent('Admitted')
    await act(async () => accept(request()))
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('Next draft')
    expect(props.api.submit).toHaveBeenCalledTimes(1)
  })

  it('admits with the last known capability when refreshing requests fails', async () => {
    const props = fixture()
    const view = render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    vi.mocked(props.api.list).mockRejectedValue(new Error('Refresh unavailable'))
    view.rerender(<AssistantRequestPanel {...props} revision={1} />)
    await screen.findByRole('alert')
    expect(screen.getByTestId('assistant-request-new')).toBeEnabled()
    fireEvent.click(screen.getByTestId('assistant-request-continue-req-a'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Followup despite refresh' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('')
    await waitFor(() =>
      expect(props.api.submit).toHaveBeenCalledWith(
        props.project.id,
        props.issue.id,
        expect.objectContaining({
          action: 'followup',
          requestId: 'req-a',
          message: 'Followup despite refresh',
        })
      )
    )
  })

  it('retains separate drafts when changing the explicit action or request target', async () => {
    const props = fixture()
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Independent draft' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-continue-req-a'))
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('')
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Supplement draft' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('Independent draft')
    fireEvent.click(screen.getByTestId('assistant-request-continue-req-a'))
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('Supplement draft')
    expect(props.api.submit).not.toHaveBeenCalled()
  })

  it('does not expose admission without current execution authority', () => {
    const props = fixture()
    render(<AssistantRequestPanel {...props} issue={{ ...props.issue, can_view_detail: false }} />)
    expect(screen.queryByTestId('assistant-requests')).toBeNull()
    expect(props.api.list).not.toHaveBeenCalled()
    expect(props.api.submit).not.toHaveBeenCalled()
  })

  it('retains the submission and idempotency key when server acceptance is uncertain', async () => {
    const props = fixture()
    vi.mocked(props.api.submit).mockRejectedValueOnce(new Error('Network timeout'))
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Independent B' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    await screen.findByRole('alert')
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('')
    expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent(
      'Independent B'
    )
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Next draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: '重试此条发送' }))
    await waitFor(() => expect(props.api.submit).toHaveBeenCalledTimes(2))
    expect(vi.mocked(props.api.submit).mock.calls[0][2].idempotencyKey).toBe(
      vi.mocked(props.api.submit).mock.calls[1][2].idempotencyKey
    )
    expect(screen.getByTestId('assistant-request-message')).toHaveValue('Next draft')
  })

  it('keeps cancellation available behind a failed supplement and another queued message', async () => {
    const props = fixture()
    vi.mocked(props.api.submit).mockRejectedValueOnce(new Error('Acceptance unknown'))
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-continue-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-continue-req-a'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Unconfirmed supplement' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    await screen.findByRole('alert')
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Queued supplement' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    expect(screen.getByTestId('assistant-request-cancel-req-a')).toBeEnabled()
    fireEvent.click(screen.getByTestId('assistant-request-cancel-req-a'))
    await waitFor(() => expect(props.api.submit).toHaveBeenCalledTimes(2))
    expect(vi.mocked(props.api.submit).mock.calls[1][2]).toMatchObject({
      action: 'cancel',
      requestId: 'req-a',
    })
    expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent(
      'Unconfirmed supplement'
    )
    expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent(
      'Queued supplement'
    )
    expect(screen.getAllByRole('button', { name: '重试此条发送' })).toHaveLength(2)
  })

  it('writes a late acceptance only to its original account scope', async () => {
    const props = fixture()
    let accept!: (value: AssistantExecutionRequest) => void
    const pending = new Promise<AssistantExecutionRequest>(resolve => {
      accept = resolve
    })
    vi.mocked(props.api.submit).mockReturnValueOnce(pending)
    const view = render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-new')
    fireEvent.click(screen.getByTestId('assistant-request-new'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Private admitted body' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    await waitFor(() => expect(props.api.submit).toHaveBeenCalledTimes(1))
    account.user = { id: 8 }
    vi.mocked(props.api.list).mockResolvedValue({
      enabled: true,
      requests: [request({ ownerUserId: 8, message: 'Owner eight' })],
    })
    view.rerender(
      <AssistantRequestPanel
        {...props}
        project={{ ...props.project, current_user_id: 8 }}
        issue={{ ...props.issue, assignee_user_id: 8 }}
      />
    )
    await screen.findByText('Owner eight')
    expect(screen.queryByText('Private admitted body')).toBeNull()
    await act(async () => accept(request()))
    expect(screen.queryByText('Private admitted body')).toBeNull()
    expect(screen.queryByText('Private request A')).toBeNull()
    account.user = { id: 7 }
    vi.mocked(props.api.list).mockResolvedValue({ enabled: true, requests: [request()] })
    view.rerender(<AssistantRequestPanel {...props} />)
    expect(screen.getByTestId('assistant-request-local-submissions')).toHaveTextContent(
      'Private admitted body'
    )
    expect(props.api.submit).toHaveBeenCalledTimes(1)
  })

  it('resolves a clicked public receipt through the owner request read before opening its private execution', async () => {
    const props = fixture()
    let resolve: (value: Awaited<ReturnType<AssistantRequestsApi['list']>>) => void = () => {}
    vi.mocked(props.api.list).mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    render(<AssistantRequestPanel {...props} openRequest={{ id: 'req-a', key: 1 }} />)
    expect(props.onExecution).not.toHaveBeenCalled()
    await act(async () => resolve({ enabled: true, requests: [request()] }))
    expect(props.onExecution).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'device',
      taskId: 'assistant-request-req-a',
    })
  })

  it('only approves the displayed merge candidate through the human confirmation API', async () => {
    const props = fixture()
    const merge = {
      state: 'awaiting_confirmation',
      targetRef: 'refs/heads/main',
      targetRevision: 'target-abc',
      requestRevision: 'request-abc',
      candidateRevision: 'candidate-abc',
      mergedRevision: null,
      conflictFiles: [],
      reasonCode: null,
    }
    const value = request({
      state: 'completed',
      worktree: {
        worktreeId: 'worktree-a',
        deviceId: 'native-device',
        request: {
          requestId: 'req-a',
          ownerUserId: 7,
          conversationId: 'assistant-request-req-a',
          deviceId: 'native-device',
        },
        sourcePath: '/repo',
        baseRevision: 'base',
        branch: 'request-branch',
        path: 'C:\\worktrees\\request',
        state: 'preserved',
        cleanupPolicy: 'preserve',
        merge,
      },
    })
    vi.mocked(props.api.list).mockResolvedValue({ enabled: true, requests: [value] })
    vi.mocked(props.api.confirmMerge).mockResolvedValue({
      ...value,
      commands: [
        {
          id: 'merge-command',
          action: 'merge',
          executionId: '11',
          approvedByUserId: 7,
          targetRevision: 'target-abc',
          candidateRevision: 'candidate-abc',
          acknowledged: false,
        },
      ],
    })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-worktree-req-a'))
    expect(screen.getByText('target-abc')).toBeVisible()
    expect(screen.getByText('candidate-abc')).toBeVisible()
    fireEvent.click(screen.getByTestId('assistant-request-confirm-merge-req-a'))
    await waitFor(() =>
      expect(props.api.confirmMerge).toHaveBeenCalledWith(
        props.project.id,
        props.issue.id,
        'req-a',
        expect.objectContaining({
          targetRevision: 'target-abc',
          candidateRevision: 'candidate-abc',
          idempotencyKey: expect.any(String),
        })
      )
    )
    expect(props.api.submit).not.toHaveBeenCalled()
  })

  it('reports conflicting files while preserving the branch without enabling approval', async () => {
    const props = fixture()
    vi.mocked(props.api.list).mockResolvedValue({
      enabled: true,
      requests: [
        request({
          state: 'completed',
          worktree: {
            worktreeId: 'worktree-a',
            deviceId: 'native-device',
            request: {
              requestId: 'req-a',
              ownerUserId: 7,
              conversationId: 'assistant-request-req-a',
              deviceId: 'native-device',
            },
            sourcePath: '/repo',
            baseRevision: 'base',
            branch: 'request-branch',
            path: '/worktrees/request',
            state: 'preserved',
            cleanupPolicy: 'preserve',
            merge: {
              state: 'conflict',
              targetRef: 'refs/heads/main',
              targetRevision: 'target',
              requestRevision: 'request',
              candidateRevision: null,
              mergedRevision: null,
              conflictFiles: ['src/app.ts'],
              reasonCode: 'merge_conflict',
            },
          },
        }),
      ],
    })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-worktree-req-a'))
    expect(screen.getByText('src/app.ts')).toBeVisible()
    expect(screen.getByText('request-branch')).toBeVisible()
    expect(screen.queryByTestId('assistant-request-confirm-merge-req-a')).toBeNull()
  })

  it('permits a fresh confirmation after a recorded publication failure for the same candidate', async () => {
    const props = fixture()
    const value = request({
      state: 'completed',
      worktree: {
        worktreeId: 'worktree-a',
        deviceId: 'native-device',
        request: {
          requestId: 'req-a',
          ownerUserId: 7,
          conversationId: 'assistant-request-req-a',
          deviceId: 'native-device',
        },
        sourcePath: '/repo',
        baseRevision: 'base',
        branch: 'request-branch',
        path: '/worktrees/request',
        state: 'preserved',
        cleanupPolicy: 'preserve',
        merge: {
          state: 'awaiting_confirmation',
          targetRef: 'refs/heads/main',
          targetRevision: 'target',
          requestRevision: 'request',
          candidateRevision: 'candidate',
          mergedRevision: null,
          conflictFiles: [],
          reasonCode: null,
          observedTargetRevision: 'observed',
          targetWorktreeDirty: true,
        },
      },
      commands: [
        {
          id: 'failed-merge',
          action: 'merge',
          executionId: '11',
          approvedByUserId: 7,
          targetRevision: 'target',
          candidateRevision: 'candidate',
          acknowledged: true,
          reasonCode: 'worktree_merge_target_dirty',
        },
      ],
    })
    vi.mocked(props.api.list).mockResolvedValue({ enabled: false, requests: [value] })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-worktree-req-a'))
    expect(screen.getByText('observed')).toBeVisible()
    expect(screen.getByTestId('assistant-request-merge-error-req-a')).toBeVisible()
    expect(screen.getByTestId('assistant-request-merge-error-req-a')).not.toBeEmptyDOMElement()
    expect(screen.getByText('worktree_merge_target_dirty')).toBeVisible()
    expect(screen.getByTestId('assistant-request-confirm-merge-req-a')).toBeEnabled()
    fireEvent.click(screen.getByTestId('assistant-request-confirm-merge-req-a'))
    await waitFor(() => expect(props.api.confirmMerge).toHaveBeenCalledTimes(1))
  })

  it('rechecks completed merge evidence without creating a request or model turn and waits for acknowledgement', async () => {
    const props = fixture()
    const value = request({
      state: 'completed',
      worktree: {
        worktreeId: 'worktree-a',
        deviceId: 'native-device',
        request: {
          requestId: 'req-a',
          ownerUserId: 7,
          conversationId: 'assistant-request-req-a',
          deviceId: 'native-device',
        },
        sourcePath: '/repo',
        baseRevision: 'base',
        branch: 'request-branch',
        path: '/worktrees/request',
        state: 'preserved',
        cleanupPolicy: 'preserve',
        merge: null,
      },
    })
    const pending = {
      ...value,
      commands: [
        { id: 'check', action: 'prepare_merge' as const, executionId: '11', acknowledged: false },
      ],
    }
    vi.mocked(props.api.list)
      .mockResolvedValueOnce({ enabled: false, requests: [value] })
      .mockResolvedValue({ enabled: false, requests: [pending] })
    vi.mocked(props.api.submit).mockResolvedValue(pending)
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-worktree-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-worktree-req-a'))
    fireEvent.click(screen.getByTestId('assistant-request-prepare-merge-req-a'))
    await waitFor(() =>
      expect(props.api.submit).toHaveBeenCalledWith(
        props.project.id,
        props.issue.id,
        expect.objectContaining({ action: 'prepare_merge', requestId: 'req-a' })
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('assistant-request-prepare-merge-req-a')).toBeDisabled()
    )
    expect(props.api.confirmMerge).not.toHaveBeenCalled()
  })

  it('does not reuse merge approvals or pending checks from a previous execution attempt', async () => {
    const props = fixture()
    const value = request({
      state: 'completed',
      commands: [
        { id: 'old-check', action: 'prepare_merge', executionId: '10', acknowledged: false },
        {
          id: 'old-approval',
          action: 'merge',
          executionId: '10',
          acknowledged: true,
          approvedByUserId: 7,
          targetRevision: 'target',
          candidateRevision: 'candidate',
        },
      ],
      worktree: {
        worktreeId: 'worktree-a',
        deviceId: 'native-device',
        request: {
          requestId: 'req-a',
          ownerUserId: 7,
          conversationId: 'assistant-request-req-a',
          deviceId: 'native-device',
        },
        sourcePath: '/repo',
        baseRevision: 'base',
        branch: 'request-branch',
        path: '/worktrees/request',
        state: 'preserved',
        cleanupPolicy: 'preserve',
        merge: {
          state: 'awaiting_confirmation',
          targetRef: 'refs/heads/main',
          targetRevision: 'target',
          requestRevision: 'request',
          candidateRevision: 'candidate',
          mergedRevision: null,
          conflictFiles: [],
          reasonCode: null,
        },
      },
    })
    vi.mocked(props.api.list).mockResolvedValue({ enabled: false, requests: [value] })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-worktree-req-a')
    fireEvent.click(screen.getByTestId('assistant-request-worktree-req-a'))
    expect(screen.getByTestId('assistant-request-prepare-merge-req-a')).toBeEnabled()
    expect(screen.getByTestId('assistant-request-confirm-merge-req-a')).toBeEnabled()
    expect(screen.queryByTestId('assistant-request-merge-error-req-a')).toBeNull()
  })

  it.each(['failed', 'cancelled'])(
    'allows retry of a %s request while new requests are disabled',
    async state => {
      const props = fixture()
      vi.mocked(props.api.list).mockResolvedValue({
        enabled: false,
        requests: [request({ state })],
      })
      render(<AssistantRequestPanel {...props} />)
      await screen.findByTestId('assistant-request-retry-req-a')
      fireEvent.click(screen.getByTestId('assistant-request-retry-req-a'))
      await waitFor(() =>
        expect(props.api.submit).toHaveBeenCalledWith(
          props.project.id,
          props.issue.id,
          expect.objectContaining({ action: 'retry', requestId: 'req-a' })
        )
      )
      expect(screen.queryByTestId('assistant-request-new')).toBeNull()
    }
  )

  it('continues a completed request using its existing identity even when new requests are disabled', async () => {
    const props = fixture()
    vi.mocked(props.api.list).mockResolvedValue({
      enabled: false,
      requests: [request({ state: 'completed' })],
    })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-continue-req-a')
    expect(screen.queryByTestId('assistant-request-cancel-req-a')).toBeNull()
    fireEvent.click(screen.getByTestId('assistant-request-continue-req-a'))
    fireEvent.change(screen.getByTestId('assistant-request-message'), {
      target: { value: 'Continue A' },
    })
    fireEvent.click(screen.getByTestId('assistant-request-send'))
    await waitFor(() =>
      expect(props.api.submit).toHaveBeenCalledWith(
        props.project.id,
        props.issue.id,
        expect.objectContaining({ action: 'followup', requestId: 'req-a', message: 'Continue A' })
      )
    )
  })

  it('keeps history and followup/cancellation when new requests are disabled', async () => {
    const props = fixture()
    vi.mocked(props.api.list).mockResolvedValue({ enabled: false, requests: [request()] })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByTestId('assistant-request-req-a')
    expect(screen.queryByTestId('assistant-request-new')).toBeNull()
    expect(screen.queryByTestId('assistant-request-replace-req-a')).toBeNull()
    fireEvent.click(screen.getByTestId('assistant-request-cancel-req-a'))
    await waitFor(() =>
      expect(props.api.submit).toHaveBeenCalledWith(
        props.project.id,
        props.issue.id,
        expect.objectContaining({ action: 'cancel', requestId: 'req-a' })
      )
    )
  })

  it('retains confirmed requests on refresh failure and offers a scoped retry', async () => {
    const props = fixture()
    const view = render(<AssistantRequestPanel {...props} />)
    await screen.findByText('Private request A')
    vi.mocked(props.api.list).mockRejectedValueOnce(new Error('offline'))
    view.rerender(<AssistantRequestPanel {...props} revision={1} />)
    await screen.findByRole('alert')
    expect(screen.getByText('Private request A')).toBeVisible()
    expect(screen.getByTestId('assistant-request-cancel-req-a')).toBeEnabled()
    fireEvent.click(screen.getByTestId('assistant-requests-retry'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('assistant-request-cancel-req-a')).toBeEnabled()
  })

  it('immediately hides another account or project and ignores late private responses', async () => {
    let resolve: (value: Awaited<ReturnType<AssistantRequestsApi['list']>>) => void = () => {}
    const props = fixture()
    vi.mocked(props.api.list).mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const view = render(<AssistantRequestPanel {...props} />)
    await waitFor(() => expect(props.api.list).toHaveBeenCalledTimes(1))
    account.user = { id: 8 }
    view.rerender(<AssistantRequestPanel {...props} />)
    await act(async () => resolve({ enabled: true, requests: [request()] }))
    expect(screen.queryByTestId('assistant-requests')).toBeNull()
    expect(screen.queryByText('Private request A')).toBeNull()
    expect(props.api.list).toHaveBeenCalledTimes(1)
  })

  it('does not fetch inactive, local, nonowner, or disabled empty request controls', async () => {
    const props = fixture()
    const view = render(<AssistantRequestPanel {...props} active={false} />)
    expect(props.api.list).not.toHaveBeenCalled()
    view.rerender(
      <AssistantRequestPanel {...props} project={{ ...props.project, project_store: 'local' }} />
    )
    expect(props.api.list).not.toHaveBeenCalled()
    view.rerender(
      <AssistantRequestPanel {...props} issue={{ ...props.issue, assignee_user_id: 8 }} />
    )
    expect(props.api.list).not.toHaveBeenCalled()
    vi.mocked(props.api.list).mockResolvedValue({ enabled: false, requests: [] })
    view.rerender(<AssistantRequestPanel {...props} />)
    await waitFor(() => expect(props.api.list).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('assistant-requests')).toBeNull()
  })

  it('rejects foreign request rows instead of displaying their private body', async () => {
    const props = fixture()
    vi.mocked(props.api.list).mockResolvedValue({
      enabled: true,
      requests: [request({ ownerUserId: 8 })],
    })
    render(<AssistantRequestPanel {...props} />)
    await screen.findByRole('alert')
    expect(screen.queryByText('Private request A')).toBeNull()
  })

  it('hides confirmed private rows immediately on a backend or project switch', async () => {
    const props = fixture()
    const view = render(<AssistantRequestPanel {...props} />)
    await screen.findByText('Private request A')
    vi.mocked(props.api.list).mockImplementation(() => new Promise(() => {}))
    account.backend = 'backend-two'
    view.rerender(<AssistantRequestPanel {...props} />)
    expect(screen.queryByText('Private request A')).toBeNull()
    const project = { ...props.project, id: 'project-two' }
    view.rerender(
      <AssistantRequestPanel
        {...props}
        project={project}
        issue={{ ...props.issue, cloud_project_id: project.id }}
      />
    )
    expect(screen.queryByText('Private request A')).toBeNull()
    await waitFor(() =>
      expect(props.api.list).toHaveBeenLastCalledWith('project-two', props.issue.id)
    )
  })
})
