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
  address: { deviceId: 'device-1', taskId: 'task-1' },
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
  context: ReplyPredictionSource | null = source,
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
                      task: { updatedAt: context.revision },
                      turn: { id: context.latestTurnId },
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
  it('uses the source session without loading transcripts or selecting a model', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const { rerender } = render(fixture(predict))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('请继续'))
    expect(predict).toHaveBeenCalledWith(
      expect.objectContaining({ address: source.address, latestTurnId: 'turn-1' })
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

  it('does not predict an unbound project comment', () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    render(fixture(predict, null))
    expect(predict).not.toHaveBeenCalled()
    expect(screen.getByText('empty')).toBeVisible()
  })
})
