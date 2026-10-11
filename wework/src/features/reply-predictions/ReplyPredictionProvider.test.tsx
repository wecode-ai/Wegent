import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import { ComposerPredictionContext } from '@wegent/collaboration/composer'
import { describe, expect, it, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { ReplyPredictionProvider } from './ReplyPredictionProvider'
import type { ReplyPredictionSource } from './replyPredictionService'

const model = {
  modelName: 'predictor',
  modelType: 'runtime',
  executionModelId: 'predictor',
  executionModelType: 'runtime',
}
const source: ReplyPredictionSource = {
  scope: 'project:1:thread:1',
  revision: 'completed-turn',
  busy: false,
  load: async () => [
    { id: 'assistant-1', status: 'completed', user: '请保留数据', assistant: '可以迁移。' },
  ],
}
const apis = new WeakMap<
  (data: { signal?: AbortSignal }) => Promise<string>,
  { generateText: (data: { signal?: AbortSignal }) => Promise<string> }
>()
function Consumer() {
  const prediction = useContext(ComposerPredictionContext)
  return prediction ? (
    <button onClick={prediction.onAccept}>{prediction.text}</button>
  ) : (
    <span>empty</span>
  )
}
function fixture(
  generateText: (data: { signal?: AbortSignal }) => Promise<string>,
  context: ReplyPredictionSource,
  blocked = false,
  enabled = true,
  copies = 1
) {
  let api = apis.get(generateText)
  if (!api) {
    api = { generateText }
    apis.set(generateText, api)
  }
  return (
    <AppPreferencesContext.Provider
      value={{
        loaded: true,
        preferences: {
          ...defaultAppPreferences,
          replyPredictionsEnabled: enabled,
          replyPredictionModel: model,
        },
      }}
    >
      <WorkbenchContext.Provider
        value={
          {
            services: { textGenerationApi: api },
            projectChat: { models: [{ name: 'predictor', type: 'runtime', isActive: true }] },
          } as unknown as WorkbenchContextValue
        }
      >
        {Array.from({ length: copies }, (_, index) => (
          <ReplyPredictionProvider key={index} source={context} blocked={blocked}>
            <Consumer />
          </ReplyPredictionProvider>
        ))}
      </WorkbenchContext.Provider>
    </AppPreferencesContext.Provider>
  )
}

describe('reply prediction provider', () => {
  it('keeps blocked drafts untouched and consumes a cached suggestion across all composers', async () => {
    const generate = vi.fn(async () => '{"suggestion":"请继续并保留数据"}')
    const { rerender } = render(fixture(generate, source, true))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button')).toBeNull()
    rerender(fixture(generate, { ...source }, false, true, 2))
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2))
    expect(generate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
    expect(screen.getAllByText('empty')).toHaveLength(2)
  })

  it('does not restart an in-flight prediction for an equivalent source and cancels when disabled', async () => {
    let signal: AbortSignal | undefined
    const generate = vi.fn(async (data: { signal?: AbortSignal }) => {
      signal = data.signal
      return new Promise<string>(() => {})
    })
    const { rerender } = render(fixture(generate, source))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    rerender(fixture(generate, { ...source }))
    expect(signal?.aborted).toBe(false)
    expect(generate).toHaveBeenCalledTimes(1)
    rerender(fixture(generate, source, false, false))
    expect(signal?.aborted).toBe(true)
  })

  it('does not launch a late prediction after its composer unmounts during transcript loading', async () => {
    let resolve!: (turns: Awaited<ReturnType<ReplyPredictionSource['load']>>) => void
    const generate = vi.fn(async () => '{"suggestion":"请继续"}')
    const pending = {
      ...source,
      load: () =>
        new Promise<Awaited<ReturnType<ReplyPredictionSource['load']>>>(done => {
          resolve = done
        }),
    }
    const { unmount } = render(fixture(generate, pending))
    unmount()
    resolve(await source.load())
    await Promise.resolve()
    expect(generate).not.toHaveBeenCalled()
  })
})
