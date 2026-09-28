// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * A code wiki with no model of its own runs on its team's, and that has to survive
 * being looked at.
 *
 * The model selector preselects, so opening this dialog on such a wiki used to put a
 * model in the box without anyone asking, and the payload sent it unconditionally.
 * Saving an unrelated setting therefore pinned a model nobody chose and replaced the
 * team fallback the wiki had been running on.
 */

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { getKnowledgeBase } from '@/apis/knowledge'
import { modelApis } from '@/apis/models'
import { codeWikiApi } from '@/apis/code-wiki'
import { EditKnowledgeBaseDialog } from '@/features/knowledge/document/components/EditKnowledgeBaseDialog'
import type { CodeWikiScheduledUpdateRequest } from '@/types/code-wiki'
import type { KnowledgeBase, KnowledgeBaseUpdate } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

jest.mock('@/apis/models', () => ({
  modelApis: { getUnifiedModels: jest.fn() },
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: {
    strategies: jest.fn(),
    configureScheduledUpdate: jest.fn(),
    deleteScheduledUpdate: jest.fn(),
  },
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseForm', () => ({
  KnowledgeBaseForm: ({ advancedExtras }: { advancedExtras?: ReactNode }) => (
    <div data-testid="knowledge-base-form">{advancedExtras}</div>
  ),
}))

jest.mock('@/features/knowledge/document/components/ConvertKnowledgeBaseTypeDialog', () => ({
  ConvertKnowledgeBaseTypeDialog: () => null,
}))

jest.mock('@/features/knowledge/code-wiki/ScheduledUpdateDialog', () => ({
  ScheduledUpdateDialog: ({
    open,
    deleteRequested,
    onDraftSaved,
    onDeleteRequested,
  }: {
    open: boolean
    deleteRequested?: boolean
    onDraftSaved: (plan: CodeWikiScheduledUpdateRequest) => void
    onDeleteRequested: () => void
  }) =>
    open ? (
      <div>
        <span data-testid="scheduled-delete-requested">{String(deleteRequested)}</span>
        <button
          type="button"
          data-testid="stage-scheduled-update"
          onClick={() =>
            onDraftSaved({
              enabled: true,
              cadence: 'daily',
              interval_days: 1,
              weekday: 0,
              hour: 10,
              minute: 0,
              timezone: 'Asia/Shanghai',
            })
          }
        >
          stage scheduled update
        </button>
        <button type="button" data-testid="stage-scheduled-delete" onClick={onDeleteRequested}>
          stage scheduled delete
        </button>
      </div>
    ) : null,
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled', () => ({
  useMultimodalFeatureEnabled: () => false,
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalKBConfig', () => ({
  useMultimodalKBConfig: () => ({
    multimodalAnalysisEnabled: false,
    multimodalVideoPrompt: null,
    multimodalImagePrompt: null,
    loadFromKB: jest.fn(),
    validate: () => true,
    clearError: jest.fn(),
    buildSubmitFields: () => ({}),
    formProps: {},
  }),
}))

const MODELS = [
  { name: 'aaa-default', namespace: 'default', type: 'public', displayName: 'AAA' },
  { name: 'zzz-picked', namespace: 'default', type: 'public', displayName: 'ZZZ' },
]

const wiki: KnowledgeBase = {
  id: 202,
  name: 'weibo_rd/user-graph-ci',
  description: null,
  user_id: 1,
  namespace: 'default',
  direct_access_requirement: 'read',
  kb_type: 'code_wiki',
  document_count: 3,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 5,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

async function openAndSave(kb: KnowledgeBase, onSubmit: jest.Mock) {
  jest.mocked(getKnowledgeBase).mockResolvedValue(kb)
  render(
    <EditKnowledgeBaseDialog
      open
      onOpenChange={jest.fn()}
      knowledgeBase={kb}
      onSubmit={onSubmit}
      knowledgeDefaultTeamId={7}
    />
  )
  await screen.findByTestId('code-wiki-execution-model-select')
  fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  return onSubmit.mock.calls[0][0] as KnowledgeBaseUpdate
}

describe('editing a code wiki that has no model of its own', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: MODELS })
    jest.mocked(codeWikiApi.strategies).mockResolvedValue({
      default_strategy: 'coordinator_adaptive',
      strategies: [
        {
          id: 'coordinator_adaptive',
          revision: 1,
          display_name: 'Adaptive',
          description: 'Adaptive generation',
        },
      ],
    })
  })

  it('sends no model at all when the field was never touched', async () => {
    const payload = await openAndSave(
      wiki,
      jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    )

    // Absent, not null: null is an instruction to clear, and writing one would
    // still be writing to a field the user never opened.
    expect('execution_model_ref' in payload).toBe(false)
  })

  it('sends the model once one is actually picked', async () => {
    const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    jest.mocked(getKnowledgeBase).mockResolvedValue(wiki)
    render(
      <EditKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={wiki}
        onSubmit={onSubmit}
        knowledgeDefaultTeamId={7}
      />
    )

    fireEvent.click(await screen.findByTestId('code-wiki-execution-model-select'))
    fireEvent.click(await screen.findByText('ZZZ'))
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].execution_model_ref).toEqual(
      expect.objectContaining({ name: 'zzz-picked' })
    )
  })

  it('keeps sending the model a wiki already had, so other edits do not drop it', async () => {
    const withModel = {
      ...wiki,
      execution_model_ref: { name: 'aaa-default', namespace: 'default', type: 'public' as const },
    }

    const payload = await openAndSave(
      withModel,
      jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    )

    expect(payload.execution_model_ref).toEqual(expect.objectContaining({ name: 'aaa-default' }))
  })

  it('stages a scheduled update until the enclosing knowledge-base save succeeds', async () => {
    const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    jest.mocked(getKnowledgeBase).mockResolvedValue(wiki)
    jest.mocked(codeWikiApi.configureScheduledUpdate).mockResolvedValue({} as never)

    render(
      <EditKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={wiki}
        onSubmit={onSubmit}
        knowledgeDefaultTeamId={7}
      />
    )

    fireEvent.click(await screen.findByTestId('code-wiki-scheduled-settings'))
    fireEvent.click(await screen.findByTestId('stage-scheduled-update'))

    expect(codeWikiApi.configureScheduledUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(codeWikiApi.configureScheduledUpdate).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(codeWikiApi.configureScheduledUpdate).mock.invocationCallOrder[0]
    )
  })

  it('keeps a staged schedule deletion visible until the knowledge base is saved', async () => {
    const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    jest.mocked(getKnowledgeBase).mockResolvedValue(wiki)
    jest.mocked(codeWikiApi.deleteScheduledUpdate).mockResolvedValue(undefined)

    render(
      <EditKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={wiki}
        onSubmit={onSubmit}
        knowledgeDefaultTeamId={7}
      />
    )

    fireEvent.click(await screen.findByTestId('code-wiki-scheduled-settings'))
    fireEvent.click(await screen.findByTestId('stage-scheduled-delete'))
    expect(await screen.findByTestId('code-wiki-scheduled-pending-change')).toHaveTextContent(
      'codeWiki.scheduledUpdate.pendingDelete'
    )

    fireEvent.click(screen.getByTestId('code-wiki-scheduled-settings'))
    expect(await screen.findByTestId('scheduled-delete-requested')).toHaveTextContent('true')
    expect(codeWikiApi.deleteScheduledUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
    await waitFor(() => expect(codeWikiApi.deleteScheduledUpdate).toHaveBeenCalledWith(wiki.id))
  })
})
