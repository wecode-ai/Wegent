import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
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
    onHistorySourceAvailabilityChange?(value: boolean): void
  }) => {
    mocks.panel(props)
    const { onHistorySourceAvailabilityChange } = props
    useEffect(() => {
      onHistorySourceAvailabilityChange?.(mocks.historyAvailable)
    }, [onHistorySourceAvailabilityChange])
    return (
      <div data-testid="native-private-panel">
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
      sourceNodeId: 'node-1',
      onPublished: vi.fn(),
      ...overrides,
    } satisfies PrivateDiscussionPaneProps,
    create,
  }
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

  it('opens the exact existing task and source turn; ordinary messages never create a shared comment', async () => {
    const { props, create } = fixture()
    render(<PrivateDiscussionPane {...props} />)
    expect(mocks.panel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialAddress: { deviceId: 'device-1', taskId: 'task-1' },
        controlledAddress: { deviceId: 'device-1', taskId: 'task-1' },
        nativeConversation: true,
        historySource: { turnId: 'turn-1', userMessageIds: ['native-user-1'] },
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
    fireEvent.change(screen.getByTestId('collaboration-exp-conclusion-text'), {
      target: { value: 'Confirmed edited conclusion' },
    })
    first.unmount()
    render(<PrivateDiscussionPane {...props} />)
    expect(screen.getByTestId('native-private-draft')).toHaveValue('Unsent private draft')
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
      expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue('')
    )
    expect(screen.getByTestId('native-private-draft')).toHaveValue('Unsent private draft')
    expect(props.onPublished).toHaveBeenCalledTimes(1)
  })

  it.each(['owner', 'source', 'native-proof', 'visibility'] as const)(
    'does not expose unverified private content: %s',
    reason => {
      const { props } = fixture()
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
      expect(screen.getByTestId('collaboration-exp-conclusion-text')).toHaveValue('')
      expect(screen.queryByDisplayValue('SECRET old draft')).not.toBeInTheDocument()
    }
  )
})
