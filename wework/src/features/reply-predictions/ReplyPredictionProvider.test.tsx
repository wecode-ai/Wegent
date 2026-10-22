import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import {
  ComposerPredictionContext,
  ComposerPredictionPendingContext,
} from '@wegent/collaboration/composer'
import { describe, expect, it, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { RuntimeTaskLifecycleContext } from '@/features/workbench/runtimeTaskLifecycle/internalContext'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { ReplyPredictionProvider } from './ReplyPredictionProvider'
import type { ReplyPredictionSource } from './replyPredictionService'

const source: ReplyPredictionSource = {
  scope: 'task-1',
  revision: 'completed-turn',
  latestTurnId: 'turn-1',
  busy: false,
  address: { deviceId: 'device-1', taskId: 'task-1', workspacePath: '/workspace' },
}
type Predict = (data: { signal?: AbortSignal }) => Promise<{ suggestion: string | null }>
const apis = new WeakMap<Predict, { predict: Predict }>()
function Consumer() {
  const prediction = useContext(ComposerPredictionContext)
  const pending = useContext(ComposerPredictionPendingContext)
  return prediction ? (
    <button onClick={prediction.onAccept}>{prediction.text}</button>
  ) : pending ? (
    <span role="status">{pending}</span>
  ) : (
    <span>empty</span>
  )
}
function fixture(
  predict: Predict,
  context:
    | (ReplyPredictionSource & { activeTurnId?: string | null; completedAt?: number })
    | null = source,
  { blocked = false, enabled = true, copies = 1, available = true, taskModel = 'task-a' } = {}
) {
  let api = apis.get(predict)
  if (!api) {
    api = { predict }
    apis.set(predict, api)
  }
  return (
    <AppPreferencesContext.Provider
      value={{
        loaded: true,
        preferences: { ...defaultAppPreferences, replyPredictionsEnabled: enabled },
      }}
    >
      <WorkbenchContext.Provider
        value={
          {
            services: { replyPredictionApi: available ? api : undefined },
            projectChat: { models: [], selectedModel: { name: taskModel, type: 'runtime' } },
          } as unknown as WorkbenchContextValue
        }
      >
        <RuntimeTaskLifecycleContext.Provider
          value={
            {
              subscribe: () => () => {},
              getSnapshot: () => context,
              selectTask: () =>
                context
                  ? {
                      task: {
                        updatedAt: context.revision,
                        completedAt: context.completedAt ?? 1000,
                        runtimeHandle: { lastTurnId: context.latestTurnId },
                        modelSelection: context.modelSelection ?? {
                          modelName: 'session-model',
                          modelType: 'runtime',
                        },
                      },
                      turn: {
                        latestId: context.latestTurnId,
                        id:
                          context.activeTurnId === undefined
                            ? context.latestTurnId
                            : context.activeTurnId,
                      },
                      derived: { isBusy: context.busy },
                      interactionStatus: null,
                    }
                  : null,
            } as unknown as RuntimeTaskLifecycleStore
          }
        >
          {Array.from({ length: copies }, (_, index) => (
            <ReplyPredictionProvider
              key={index}
              address={context?.address ?? null}
              blocked={blocked}
            >
              <Consumer />
            </ReplyPredictionProvider>
          ))}
        </RuntimeTaskLifecycleContext.Provider>
      </WorkbenchContext.Provider>
    </AppPreferencesContext.Provider>
  )
}

describe('reply prediction provider', () => {
  it('preserves pending generation when task refresh reorders model configuration fields', async () => {
    let resolve!: (value: { suggestion: string }) => void
    const predict = vi.fn<Predict>(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const modelSelection = {
      modelName: 'gpt-5.6-luna',
      modelType: 'runtime' as const,
      options: { speed: 'standard', collaborationMode: 'default', codexProviderId: 'test' },
    }
    const { rerender } = render(fixture(predict, { ...source, modelSelection }))
    expect(screen.getByRole('status')).toBeInTheDocument()

    rerender(
      fixture(predict, {
        ...source,
        modelSelection: {
          options: { codexProviderId: 'test', collaborationMode: 'default', speed: 'standard' },
          modelType: 'runtime',
          modelName: 'gpt-5.6-luna',
        },
      })
    )

    expect(predict).toHaveBeenCalledTimes(1)
    expect(predict.mock.calls[0][0].signal!.aborted).toBe(false)
    resolve({ suggestion: '请继续' })
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
  })

  it.each([
    { workspaceKind: 'chat' },
    { projectSession: { projectId: 'project-1', issueId: 'issue-1' } },
  ])('predicts non-workspace sessions and preserves their address: %j', async session => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const address = { ...source.address, workspacePath: undefined, ...session }
    const { rerender } = render(fixture(predict, { ...source, address }))

    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledWith(expect.objectContaining({ address }))

    rerender(fixture(predict, { ...source, address: { ...address, workspacePath: '/session' } }))
    expect(predict).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).toHaveTextContent('请继续')
  })

  it('waits for the task workspace to be restored before generating or reading its cache', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(
      fixture(predict, {
        ...source,
        address: { ...source.address, workspacePath: undefined },
      })
    )
    expect(predict).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()

    rerender(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledTimes(1)
    expect(predict).toHaveBeenCalledWith(expect.objectContaining({ address: source.address }))
  })

  it.each(['suggestion', 'failure'])(
    'refreshes a cached %s when the session model changes',
    async state => {
      const predict = vi.fn<Predict>()
      if (state === 'failure') predict.mockRejectedValueOnce(new Error('401'))
      else predict.mockResolvedValueOnce({ suggestion: '旧模型建议' })
      predict.mockResolvedValueOnce({ suggestion: '新模型建议' })
      const { rerender } = render(fixture(predict))
      await waitFor(() =>
        expect(
          state === 'failure'
            ? screen.getByTestId('reply-prediction-error')
            : screen.getByRole('button')
        ).toBeVisible()
      )
      const updated = {
        ...source,
        modelSelection: { modelName: 'new-session-model', modelType: 'runtime' as const },
      }
      rerender(fixture(predict, updated))
      await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('新模型建议'))
      expect(screen.queryByTestId('reply-prediction-error')).not.toBeInTheDocument()
      expect(predict).toHaveBeenCalledTimes(2)
      expect(predict).toHaveBeenLastCalledWith(
        expect.objectContaining({ latestTurnId: 'turn-1', modelSelection: updated.modelSelection })
      )
      rerender(fixture(predict, { ...updated, modelSelection: { ...updated.modelSelection } }))
      expect(predict).toHaveBeenCalledTimes(2)
    }
  )

  it('shows a failure without exposing provider details and clears it on the next turn', async () => {
    const predict = vi
      .fn()
      .mockRejectedValueOnce(new Error('401 secret provider details'))
      .mockResolvedValueOnce({ suggestion: '恢复后的建议' })
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByTestId('reply-prediction-error')).toBeVisible())
    expect(screen.queryByText(/secret provider details/)).not.toBeInTheDocument()
    expect(screen.queryByText('正在生成建议…')).not.toBeInTheDocument()
    rerender(fixture(predict, { ...source, latestTurnId: 'turn-2' }))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('恢复后的建议'))
    expect(screen.queryByTestId('reply-prediction-error')).not.toBeInTheDocument()
  })

  it('uses the source session without loading transcripts or selecting a model', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledWith(
      expect.objectContaining({
        address: source.address,
        latestTurnId: 'turn-1',
        modelSelection: { modelName: 'session-model', modelType: 'runtime' },
      })
    )
    rerender(fixture(predict, source, { taskModel: 'task-b' }))
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('does not let an unavailable pane cancel another pane sharing the API', async () => {
    let resolve!: (result: { suggestion: string }) => void
    const predict = vi.fn<Predict>(
      () =>
        new Promise<{ suggestion: string }>(done => {
          resolve = done
        })
    )
    const { rerender } = render(<>{fixture(predict)}</>)
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    rerender(
      <>
        {fixture(predict)}
        {fixture(predict, { ...source, scope: 'unavailable' }, { available: false })}
      </>
    )
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(false)
    resolve({ suggestion: '请继续' })
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('prevents busy generation and cancels a prediction when a new turn starts', async () => {
    const predict = vi.fn<Predict>(() => new Promise<{ suggestion: string | null }>(() => {}))
    const { rerender } = render(fixture(predict, { ...source, busy: true }))
    expect(predict).not.toHaveBeenCalled()
    rerender(fixture(predict))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toBeVisible()
    rerender(fixture(predict, { ...source, busy: true }))
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('protects blocked drafts and consumes a cached suggestion across composers', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续并保留数据' }))
    const { rerender } = render(fixture(predict, source, { blocked: true }))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button')).toBeNull()
    rerender(fixture(predict, { ...source }, { copies: 2 }))
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('keeps equivalent requests running and cancels when disabled', async () => {
    const predict = vi.fn<Predict>(() => new Promise<{ suggestion: string | null }>(() => {}))
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    rerender(fixture(predict, { ...source }))
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(false)
    rerender(fixture(predict, source, { enabled: false }))
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(true)
  })

  it('keeps a pending prediction when native recovery reorders the same model options', async () => {
    let resolve!: (result: { suggestion: string }) => void
    const predict = vi.fn<Predict>(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const original = {
      ...source,
      modelSelection: {
        modelName: 'session-model',
        modelType: 'runtime' as const,
        options: { collaborationMode: 'default', speed: 'standard', codexProviderId: 'provider' },
      },
    }
    const { rerender } = render(fixture(predict, original))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))

    rerender(
      fixture(predict, {
        ...original,
        modelSelection: {
          options: { codexProviderId: 'provider', speed: 'standard', collaborationMode: 'default' },
          modelType: 'runtime',
          modelName: 'session-model',
        },
      })
    )

    expect(predict.mock.calls[0][0].signal?.aborted).toBe(false)
    expect(predict).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toBeVisible()
    resolve({ suggestion: '请继续' })
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
  })

  it('keeps a completed-turn prediction when a task refresh clears the active turn ID', async () => {
    let resolve!: (result: { suggestion: string }) => void
    const predict = vi.fn<Predict>(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    rerender(fixture(predict, { ...source, activeTurnId: null, revision: 'metadata-update' }))
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(false)
    expect(predict).toHaveBeenCalledTimes(1)
    resolve({ suggestion: '请继续' })
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
  })

  it('waits for the confirmed turn identity before requesting a prediction', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(fixture(predict, { ...source, latestTurnId: undefined }))
    expect(predict).not.toHaveBeenCalled()
    rerender(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledTimes(1)
    expect(predict).toHaveBeenCalledWith(expect.objectContaining({ latestTurnId: 'turn-1' }))
  })

  it('does not regenerate an accepted suggestion after a metadata refresh', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    fireEvent.click(screen.getByRole('button'))

    rerender(fixture(predict, { ...source, revision: 'refreshed-metadata' }))

    expect(screen.getByText('empty')).toBeVisible()
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('generates a new suggestion for the next completed turn', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    fireEvent.click(screen.getByRole('button'))

    rerender(fixture(predict, { ...source, latestTurnId: 'turn-2', busy: true }))
    expect(screen.queryByRole('button')).toBeNull()
    expect(predict).toHaveBeenCalledTimes(1)
    rerender(fixture(predict, { ...source, latestTurnId: 'turn-2' }))

    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledTimes(2)
    expect(predict).toHaveBeenLastCalledWith(expect.objectContaining({ latestTurnId: 'turn-2' }))
  })

  it('does not predict an unbound project comment', () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    render(fixture(predict, null))
    expect(predict).not.toHaveBeenCalled()
    expect(screen.getByText('empty')).toBeVisible()
  })
})
