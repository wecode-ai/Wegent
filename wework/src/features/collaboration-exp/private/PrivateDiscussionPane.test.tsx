import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import {
  experienceIssueFixture as issue,
  experienceProjectFixture as project,
} from '../model/fixtures'
import { PrivateDiscussionPane, type PrivateDiscussionPaneProps } from './PrivateDiscussionPane'

const mocks = vi.hoisted(() => ({
  userId: 7,
  apiBaseUrl: 'https://cloud.example/api',
  historyAvailable: true,
  runtimeSend: vi.fn(),
  panel: vi.fn(),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: { user: { id: mocks.userId } }, openRuntimeTask: vi.fn() }),
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useCloudConnection: () => ({ isConnected: true, apiBaseUrl: mocks.apiBaseUrl }),
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: {
    draft: { value: string; onChange(value: string): void }
    composerHeader?: ReactNode
    readOnly?: boolean
    active?: boolean
    onHistorySourceAvailabilityChange?(value: boolean): void
  }) => {
    mocks.panel(props)
    const { onHistorySourceAvailabilityChange } = props
    useEffect(() => {
      onHistorySourceAvailabilityChange?.(mocks.historyAvailable)
    }, [onHistorySourceAvailabilityChange])
    return (
      <div data-testid="native-private-panel">
        {!props.readOnly && props.active !== false && (
          <>
            {props.composerHeader}
            <textarea
              data-testid="native-private-draft"
              value={props.draft.value}
              onChange={event => props.draft.onChange(event.target.value)}
            />
            <button
              data-testid="native-private-send"
              onClick={() => mocks.runtimeSend(props.draft.value)}
            >
              send privately
            </button>
          </>
        )}
      </div>
    )
  },
}))

function fixture(overrides: Partial<PrivateDiscussionPaneProps> = {}) {
  const create = vi.fn(async () => ({ id: 'comment-1' }))
  const api = {
    projects: { get: vi.fn(async () => project()) },
    issues: { get: vi.fn(async () => issue()) },
    comments: { create },
  } as unknown as SharedWorkspaceApi
  return {
    props: {
      api,
      project: project(),
      issue: issue(),
      conversation: {
        key: '["device-1","task-1"]',
        bindingIds: ['binding-1'],
        ownerUserId: 7,
        address: { deviceId: 'device-1', taskId: 'task-1' },
        title: 'Private discussion',
        linkedAt: null,
        sourceNodeIds: ['node-1'],
        historySource: { turnId: 'turn-1', userMessageIds: ['native-user-1'] },
      },
      historyScope: 'task',
      onPublished: vi.fn(),
      ...overrides,
    } satisfies PrivateDiscussionPaneProps,
    create,
  }
}

function openConclusion() {
  fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-open'))
  return screen.getByTestId('collaboration-exp-conclusion-text')
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.userId = 7
  mocks.apiBaseUrl = 'https://cloud.example/api'
  mocks.historyAvailable = true
})
afterEach(cleanup)

describe('private discussion pane', () => {
  it('uses task context and the original source history without a second embedded pane heading', () => {
    const onClose = vi.fn()
    const { props } = fixture({
      embedded: true,
      onClose,
      historyScope: 'source',
      sourceNodeId: 'node-1',
    })
    render(<PrivateDiscussionPane {...props} />)
    expect(screen.getByText(props.issue.title)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'private.title' })).toBeNull()
    expect(screen.getByText('private.sourceScope')).toBeInTheDocument()
    expect(mocks.panel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        historySource: { turnId: 'turn-1', userMessageIds: ['native-user-1'] },
        controlledAddress: { deviceId: 'device-1', taskId: 'task-1' },
        runtimeContext: { conversationContext: 'private_discussion' },
        readOnly: true,
      })
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-private-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps source history read-only and continues the same native address and ordinary draft', () => {
    const onContinue = vi.fn()
    const { props, create } = fixture({ onContinue })
    const view = render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(screen.getByTestId('native-private-draft'), {
      target: { value: 'My unsent private draft' },
    })
    view.rerender(<PrivateDiscussionPane {...props} historyScope="source" sourceNodeId="node-1" />)
    expect(screen.queryByTestId('native-private-draft')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-exp-conclusion-open')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-exp-conclusion-form')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-private-continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)
    view.rerender(<PrivateDiscussionPane {...props} />)
    expect(screen.getByTestId('native-private-draft')).toHaveValue('My unsent private draft')
    expect(mocks.panel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        controlledAddress: props.conversation.address,
        historySource: undefined,
        readOnly: false,
      })
    )
    expect(mocks.runtimeSend).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('replaces native messages with the inline preview and restores focus and both drafts on return', () => {
    const onConclusionViewChange = vi.fn()
    const { props, create } = fixture({ onConclusionViewChange })
    render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(screen.getByTestId('native-private-draft'), {
      target: { value: 'Ordinary input stays private' },
    })
    fireEvent.change(openConclusion(), { target: { value: 'My manually edited conclusion' } })
    expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveFocus()
    expect(screen.getByTestId('native-private-panel').parentElement).not.toBeVisible()
    expect(screen.queryByTestId('native-private-draft')).not.toBeInTheDocument()
    expect(onConclusionViewChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-back'))
    expect(screen.queryByTestId('collaboration-exp-conclusion-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('native-private-draft')).toHaveValue('Ordinary input stays private')
    expect(screen.getByTestId('collaboration-exp-conclusion-open')).toHaveFocus()
    expect(onConclusionViewChange).toHaveBeenLastCalledWith(false)
    expect(openConclusion()).toHaveValue('My manually edited conclusion')
    expect(create).not.toHaveBeenCalled()
    expect(mocks.runtimeSend).not.toHaveBeenCalled()
  })

  it('allows an empty current discussion to review and explicitly publish a manually entered body', async () => {
    mocks.historyAvailable = false
    const { props, create } = fixture()
    props.conversation.historySource = undefined
    render(<PrivateDiscussionPane {...props} />)
    expect(screen.getByTestId('native-private-draft')).toBeInTheDocument()
    expect(openConclusion()).toHaveValue('')
    expect(screen.getByTestId('collaboration-exp-conclusion-publish')).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('collaboration-exp-conclusion-text'), {
      target: { value: 'Only my confirmed text' },
    })
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
    await waitFor(() =>
      expect(create).toHaveBeenCalledExactlyOnceWith(issue().id, 'Only my confirmed text', {
        clientMessageId: expect.any(String),
      })
    )
    await waitFor(() => expect(screen.getByTestId('native-private-draft')).toBeInTheDocument())
  })

  it('retains the preview and draft when publication fails', async () => {
    const { props, create } = fixture()
    create.mockRejectedValueOnce(new Error('offline'))
    render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(openConclusion(), { target: { value: 'Keep the unsubmitted conclusion' } })
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('private.errors.failed')
    )
    expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue(
      'Keep the unsubmitted conclusion'
    )
    expect(props.onPublished).not.toHaveBeenCalled()
    expect(screen.getByTestId('native-private-panel').parentElement).not.toBeVisible()
  })

  it('keeps a successful publication refresh error visible without republishing the accepted body', async () => {
    const { props, create } = fixture({
      onPublished: vi.fn(async () => {
        throw new Error('refresh failed')
      }),
    })
    render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(openConclusion(), { target: { value: 'Accepted conclusion' } })
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('private.errors.refresh')
    )
    expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue('')
    expect(screen.getByTestId('collaboration-exp-conclusion-publish')).toBeDisabled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('invalidates an outstanding permission check when returning to discussion', async () => {
    let resolveProject!: (value: ReturnType<typeof project>) => void
    const { props, create } = fixture()
    vi.mocked(props.api.projects.get).mockImplementationOnce(
      () => new Promise(resolve => (resolveProject = resolve))
    )
    render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(openConclusion(), { target: { value: 'Never admitted while closed' } })
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-back'))
    await act(async () => resolveProject(project()))
    expect(create).not.toHaveBeenCalled()
    expect(openConclusion()).toHaveValue('Never admitted while closed')
    expect(screen.getByRole('alert')).toHaveTextContent('private.errors.stale')
  })

  it('does not let a late refresh completion close a newly opened preview', async () => {
    let finishRefresh!: () => void
    const onPublished = vi.fn(() => new Promise<void>(resolve => (finishRefresh = resolve)))
    const { props, create } = fixture({ onPublished })
    render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(openConclusion(), { target: { value: 'First accepted conclusion' } })
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-back'))
    fireEvent.change(openConclusion(), { target: { value: 'A different unsent conclusion' } })
    await act(async () => finishRefresh())
    expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue(
      'A different unsent conclusion'
    )
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not reuse local reader identities after the current profile changes', () => {
    const { props } = fixture({
      project: project({ project_store: 'local', current_user_id: 7 }),
      participationViewer: [0, 7],
    })
    props.conversation.ownerUserId = 0
    mocks.userId = 8
    render(<PrivateDiscussionPane {...props} />)
    expect(screen.getByTestId('collaboration-exp-private-unavailable')).toBeInTheDocument()
    expect(mocks.panel).not.toHaveBeenCalled()
  })

  it.each([0, 7])(
    'reads local owner %s and publishes as the current profile actor',
    async owner => {
      const localProject = project({ project_store: 'local', current_user_id: 7 })
      const { props, create } = fixture({ project: localProject, participationViewer: [0, 7] })
      props.conversation.ownerUserId = owner
      vi.mocked(props.api.projects.get).mockResolvedValue(localProject)
      render(<PrivateDiscussionPane {...props} />)
      expect(screen.getByTestId('native-private-panel')).toBeInTheDocument()
      openConclusion()
      fireEvent.change(await screen.findByTestId('collaboration-exp-conclusion-text'), {
        target: { value: 'Confirmed local conclusion' },
      })
      fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(props.onPublished).toHaveBeenCalledTimes(1))
    }
  )

  it.each([
    ['local', 8, [0, 7]],
    ['backend', 0, [0, 7]],
    ['backend', 8, [0, 7]],
    ['local', 0, []],
  ] as const)('rejects private %s owner %s outside the source reader', (store, owner, readers) => {
    const { props } = fixture({
      project: project({ project_store: store }),
      participationViewer: readers,
    })
    props.conversation.ownerUserId = owner
    render(<PrivateDiscussionPane {...props} />)
    expect(screen.getByTestId('collaboration-exp-private-unavailable')).toBeInTheDocument()
    expect(mocks.panel).not.toHaveBeenCalled()
  })

  it.each([0, 8])(
    'retains a local native-owner draft when fresh actor changes to %s',
    async actor => {
      const localProject = project({ project_store: 'local', current_user_id: 7 })
      const { props, create } = fixture({ project: localProject, participationViewer: [0, 7] })
      props.conversation.ownerUserId = 0
      vi.mocked(props.api.projects.get).mockResolvedValue({
        ...localProject,
        current_user_id: actor,
      })
      render(<PrivateDiscussionPane {...props} />)
      openConclusion()
      fireEvent.change(await screen.findByTestId('collaboration-exp-conclusion-text'), {
        target: { value: 'Keep my local conclusion' },
      })
      fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('private.errors.stale')
      )
      expect(create).not.toHaveBeenCalled()
      expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue(
        'Keep my local conclusion'
      )
    }
  )

  it('opens the exact existing current task; ordinary messages never create a shared comment', async () => {
    const { props, create } = fixture()
    render(<PrivateDiscussionPane {...props} />)
    expect(mocks.panel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialAddress: { deviceId: 'device-1', taskId: 'task-1' },
        controlledAddress: { deviceId: 'device-1', taskId: 'task-1' },
        nativeConversation: true,
        historySource: undefined,
      })
    )
    fireEvent.change(screen.getByTestId('native-private-draft'), {
      target: { value: 'Private context and attachment discussion' },
    })
    fireEvent.click(screen.getByTestId('native-private-send'))
    expect(mocks.runtimeSend).toHaveBeenCalledWith('Private context and attachment discussion')
    expect(create).not.toHaveBeenCalled()
  })

  it('publishes only confirmed edited text and restores both drafts after a full component restart', async () => {
    const { props, create } = fixture()
    const first = render(<PrivateDiscussionPane {...props} />)
    fireEvent.change(screen.getByTestId('native-private-draft'), {
      target: { value: 'Unsent private draft' },
    })
    openConclusion()
    fireEvent.change(screen.getByTestId('collaboration-exp-conclusion-text'), {
      target: { value: 'Confirmed edited conclusion' },
    })
    first.unmount()
    render(<PrivateDiscussionPane {...props} />)
    expect(screen.getByTestId('native-private-draft')).toHaveValue('Unsent private draft')
    openConclusion()
    expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue(
      'Confirmed edited conclusion'
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-conclusion-publish'))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('EXP-1', 'Confirmed edited conclusion', {
        clientMessageId: expect.any(String),
      })
    )
    expect(create).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByTestId('collaboration-exp-conclusion-form')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('native-private-draft')).toHaveValue('Unsent private draft')
    expect(props.onPublished).toHaveBeenCalledTimes(1)
    expect(openConclusion()).toHaveValue('')
  })

  it.each(['owner', 'source', 'native-proof', 'visibility'] as const)(
    'does not expose unverified private content: %s',
    reason => {
      const { props } = fixture({ historyScope: 'source', sourceNodeId: 'node-1' })
      if (reason === 'owner') props.conversation.ownerUserId = 8
      if (reason === 'source') props.sourceNodeId = 'missing-node'
      if (reason === 'visibility') props.issue.can_view_detail = false
      if (reason === 'native-proof') mocks.historyAvailable = false
      render(<PrivateDiscussionPane {...props} />)
      if (reason !== 'native-proof') {
        expect(screen.getByTestId('collaboration-exp-private-unavailable')).toHaveTextContent(
          'private.sourceUnavailable'
        )
        expect(mocks.panel).not.toHaveBeenCalled()
      }
      expect(screen.queryByTestId('collaboration-exp-conclusion-text')).not.toBeInTheDocument()
    }
  )

  it.each(['account', 'backend', 'store', 'task', 'source'] as const)(
    'isolates persisted text when its identity changes: %s',
    change => {
      const { props } = fixture()
      const view = render(<PrivateDiscussionPane {...props} />)
      openConclusion()
      fireEvent.change(screen.getByTestId('collaboration-exp-conclusion-text'), {
        target: { value: 'SECRET old draft' },
      })
      if (change === 'account') {
        mocks.userId = 8
        props.project.current_user_id = 8
        props.conversation.ownerUserId = 8
      }
      if (change === 'backend') mocks.apiBaseUrl = 'https://other.example/api'
      if (change === 'store') props.project.project_store = 'local'
      if (change === 'task') props.conversation.address = { deviceId: 'device-2', taskId: 'task-1' }
      if (change === 'source') {
        props.sourceNodeId = 'node-2'
        props.conversation.sourceNodeIds = ['node-2']
      }
      view.rerender(<PrivateDiscussionPane {...props} />)
      if (!screen.queryByTestId('collaboration-exp-conclusion-text')) openConclusion()
      expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue('')
      expect(screen.queryByDisplayValue('SECRET old draft')).not.toBeInTheDocument()
    }
  )
})
