// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { QueueEditDialog } from '@/features/inbox/components/QueueEditDialog'
import { createWorkQueue } from '@/apis/work-queue'

const mockRefreshQueues = jest.fn().mockResolvedValue(undefined)
const mockGetDefaultTeams = jest.fn().mockResolvedValue({
  chat: { name: 'queue-team' },
})

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/features/inbox/contexts/inboxContext', () => ({
  useInboxContext: () => ({
    refreshQueues: mockRefreshQueues,
  }),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: [
      {
        id: 7,
        name: 'queue-team',
        namespace: 'default',
        agent_type: 'chat',
        bots: [],
      },
    ],
    isTeamsLoading: false,
  }),
}))

jest.mock('@/apis/subscription', () => ({
  subscriptionApis: {
    getSubscriptions: jest.fn().mockResolvedValue({ items: [] }),
  },
}))

jest.mock('@/apis/work-queue', () => {
  const actual = jest.requireActual('@/apis/work-queue')
  return {
    ...actual,
    createWorkQueue: jest.fn(),
    updateWorkQueue: jest.fn(),
  }
})

jest.mock('@/apis/user', () => ({
  userApis: {
    getDefaultTeams: (...args: unknown[]) => mockGetDefaultTeams(...args),
  },
}))

jest.mock('@/features/settings/components/teams/TeamIconDisplay', () => ({
  TeamIconDisplay: () => <span data-testid="team-icon" />,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({
    value,
    onValueChange,
    items,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    items: Array<{ value: string; label: string }>
  }) => {
    return (
      <select
        data-testid="queue-team-searchable-select"
        value={value ?? ''}
        onChange={event => onValueChange?.(event.target.value)}
      >
        <option value="">select</option>
        {items.map(item => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    )
  },
}))

jest.mock('@/features/tasks/components/selector/ModelSelector', () => ({
  __esModule: true,
  DEFAULT_MODEL_NAME: '__default__',
  default: ({
    selectedModel,
    setSelectedModel,
    forceOverride,
    setForceOverride,
  }: {
    selectedModel: { name: string } | null
    setSelectedModel: (model: {
      name: string
      provider: string
      modelId: string
      type: 'public'
      namespace: string
    }) => void
    forceOverride: boolean
    setForceOverride: (value: boolean) => void
  }) => (
    <div>
      <button
        type="button"
        data-testid="queue-select-gpt-5"
        onClick={() =>
          setSelectedModel({
            name: 'gpt-5',
            provider: 'openai',
            modelId: 'gpt-5',
            type: 'public',
            namespace: 'default',
          })
        }
      >
        Select GPT 5
      </button>
      <label htmlFor="queue-force-override-model-switch">Override</label>
      <input
        id="queue-force-override-model-switch"
        data-testid="queue-force-override-model-switch"
        type="checkbox"
        checked={forceOverride}
        onChange={event => setForceOverride(event.target.checked)}
      />
      <div data-testid="queue-current-model">{selectedModel?.name ?? 'none'}</div>
    </div>
  ),
}))

describe('QueueEditDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(createWorkQueue as jest.Mock).mockResolvedValue({ id: 1 })
  })

  it('saves direct agent model override settings into queue auto process config', async () => {
    const user = userEvent.setup()

    render(<QueueEditDialog open onOpenChange={jest.fn()} />)

    await user.type(screen.getByTestId('queue-name-input'), 'triage')
    await user.type(screen.getByTestId('queue-display-name-input'), 'Triage Queue')
    await user.click(screen.getByTestId('auto-process-toggle'))

    await waitFor(() => {
      expect(screen.getByTestId('queue-team-searchable-select')).toHaveValue('7')
    })

    await waitFor(() => {
      expect(screen.getByTestId('queue-model-selector')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('queue-select-gpt-5'))
    await user.click(screen.getByTestId('queue-force-override-model-switch'))
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => {
      expect(createWorkQueue).toHaveBeenCalledWith({
        name: 'triage',
        displayName: 'Triage Queue',
        description: undefined,
        visibility: 'private',
        autoProcess: {
          enabled: true,
          mode: 'direct_agent',
          triggerMode: 'immediate',
          subscriptionRef: undefined,
          teamRef: {
            namespace: 'default',
            name: 'queue-team',
          },
          modelRef: {
            namespace: 'default',
            name: 'gpt-5',
          },
          forceOverrideBotModel: true,
        },
      })
    })
  })
})
