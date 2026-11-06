import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { RuntimeTaskLifecycleContext } from '@/features/workbench/runtimeTaskLifecycle/internalContext'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { render, screen, waitFor } from '@testing-library/react'
import {
  ComposerPredictionContext,
  ComposerPredictionPendingContext,
} from '@wegent/collaboration/composer'
import { useContext } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
  it('refreshes a cached failure when the session model changes', async () => {
    const predict = vi
      .fn<Predict>()
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValueOnce({ suggestion: '新模型建议' })
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByText('empty')).toBeVisible())
    expect(screen.queryByTestId('reply-prediction-error')).not.toBeInTheDocument()
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
  })

  it('keeps failures silent and recovers on the next turn', async () => {
    const predict = vi
      .fn()
      .mockRejectedValueOnce(new Error('401 secret provider details'))
      .mockResolvedValueOnce({ suggestion: '恢复后的建议' })
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByText('empty')).toBeVisible())
    expect(predict).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('reply-prediction-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/secret provider details/)).not.toBeInTheDocument()
    expect(screen.queryByText('正在生成建议…')).not.toBeInTheDocument()
    rerender(fixture(predict, { ...source, latestTurnId: 'turn-2' }))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('恢复后的建议'))
    expect(screen.queryByTestId('reply-prediction-error')).not.toBeInTheDocument()
  })

  it('keeps cached failures silent after remounting without repeating the request', async () => {
    const predict = vi.fn().mockRejectedValue(new Error('401'))
    const { unmount } = render(fixture(predict))
    await waitFor(() => expect(screen.getByText('empty')).toBeVisible())
    unmount()

    render(fixture(predict))

    await waitFor(() => expect(screen.getByText('empty')).toBeVisible())
    expect(screen.queryByTestId('reply-prediction-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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

  it('waits for the confirmed turn identity before requesting a prediction', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(fixture(predict, { ...source, latestTurnId: undefined }))
    expect(predict).not.toHaveBeenCalled()
    rerender(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledTimes(1)
    expect(predict).toHaveBeenCalledWith(expect.objectContaining({ latestTurnId: 'turn-1' }))
  })

  it('does not predict an unbound project comment', () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    render(fixture(predict, null))
    expect(predict).not.toHaveBeenCalled()
    expect(screen.getByText('empty')).toBeVisible()
  })
})
