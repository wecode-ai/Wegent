import { Activity, useContext } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ComposerPredictionContext } from '@wegent/collaboration/composer'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { RuntimeTaskLifecycleProvider } from '@/features/workbench/runtimeTaskLifecycle'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import { ReplyPredictionCoordinator } from './ReplyPredictionCoordinator'
import { ReplyPredictionProvider } from './ReplyPredictionProvider'
import { ReplyPredictionService, runtimeReplyPredictionSource } from './replyPredictionService'

const address: RuntimeTaskAddress = {
  deviceId: 'local',
  taskId: 'background-task',
  workspacePath: '/workspace',
}

function Consumer() {
  const prediction = useContext(ComposerPredictionContext)
  return <span>{prediction?.text ?? 'empty'}</span>
}

function setup() {
  const store = new RuntimeTaskLifecycleStore('prediction-coordinator')
  const predict =
    vi.fn<(data: { signal?: AbortSignal }) => Promise<{ suggestion: string | null }>>()
  predict.mockResolvedValue({ suggestion: '请继续验证' })
  const api = { predict }
  const services = { replyPredictionApi: api } as unknown as WorkbenchServices
  const fixture = ({ enabled = true, composer = false, visible = true } = {}) => (
    <AppPreferencesContext.Provider
      value={{
        loaded: true,
        preferences: { ...defaultAppPreferences, replyPredictionsEnabled: enabled },
      }}
    >
      <ReplyPredictionCoordinator services={services} store={store} />
      <WorkbenchContext.Provider value={{ services } as WorkbenchContextValue}>
        <RuntimeTaskLifecycleProvider store={store}>
          <Activity mode={visible ? 'visible' : 'hidden'}>
            {composer && (
              <ReplyPredictionProvider address={address}>
                <Consumer />
              </ReplyPredictionProvider>
            )}
          </Activity>
        </RuntimeTaskLifecycleProvider>
      </WorkbenchContext.Provider>
    </AppPreferencesContext.Provider>
  )
  const start = (target = address, turnId = 'turn-1') => store.turnStarted(target, turnId)
  const finish = (target = address, turnId = 'turn-1') => {
    store.executorSettled(target)
    store.turnSettled(target, turnId, 'succeeded')
  }
  return { store, predict, api, fixture, start, finish }
}

describe('window reply prediction coordinator', () => {
  it('generates without a mounted composer and reuses the persisted result when returning', async () => {
    const { store, predict, api, fixture, start, finish } = setup()
    const view = render(fixture())
    act(() => start())
    expect(predict).not.toHaveBeenCalled()
    act(() => finish())
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    const source = runtimeReplyPredictionSource(address, store.getTask(address))!
    expect((await new ReplyPredictionService(api).request(source))?.text).toBe('请继续验证')
    view.rerender(fixture({ composer: true }))
    await waitFor(() => expect(screen.getByText('请继续验证')).toBeVisible())
    expect(predict).toHaveBeenCalledTimes(1)
    act(() => store.markRead(address))
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('keeps an in-flight composer prediction alive when its Activity becomes hidden', async () => {
    const { predict, fixture, start, finish } = setup()
    let resolve!: (result: { suggestion: string }) => void
    predict.mockImplementation(() => new Promise(done => (resolve = done)))
    act(() => {
      start()
      finish()
    })
    const view = render(fixture({ composer: true }))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    view.rerender(fixture({ composer: true, visible: false }))
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(false)
    await act(async () => resolve({ suggestion: '后台完成的建议' }))
    view.rerender(fixture({ composer: true }))
    await waitFor(() => expect(screen.getByText('后台完成的建议')).toBeVisible())
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('does not generate a historical backlog but observes later completed turn identities', async () => {
    const { store, predict, fixture, start, finish } = setup()
    start()
    finish()
    render(fixture())
    expect(predict).not.toHaveBeenCalled()
    act(() => store.turnSettled(address, 'turn-2', 'succeeded'))
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    expect(predict).toHaveBeenCalledWith(expect.objectContaining({ latestTurnId: 'turn-2' }))
  })

  it('cancels stale work on a new turn and caches only the latest response', async () => {
    const { store, predict, api, fixture, start, finish } = setup()
    let resolve!: (result: { suggestion: string }) => void
    predict.mockImplementationOnce(() => new Promise(done => (resolve = done)))
    render(fixture())
    act(() => {
      start()
      finish()
    })
    expect(predict).toHaveBeenCalledTimes(1)
    act(() => start(address, 'turn-2'))
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(true)
    act(() => finish(address, 'turn-2'))
    await act(async () => resolve({ suggestion: '过期建议' }))
    const source = runtimeReplyPredictionSource(address, store.getTask(address))!
    expect((await new ReplyPredictionService(api).request(source))?.text).toBe('请继续验证')
    expect(predict).toHaveBeenCalledTimes(2)
  })

  it.each(['disable', 'remove', 'close'] as const)(
    'cancels generation on %s and does not restart it on unrelated updates',
    async action => {
      const { store, predict, fixture, start, finish } = setup()
      predict.mockImplementation(() => new Promise(() => {}))
      const view = render(fixture())
      act(() => {
        start()
        finish()
      })
      expect(predict).toHaveBeenCalledTimes(1)
      if (action === 'disable') view.rerender(fixture({ enabled: false }))
      if (action === 'remove') act(() => store.remove(address))
      if (action === 'close') view.unmount()
      expect(predict.mock.calls[0][0].signal?.aborted).toBe(true)
      act(() => store.executorSettled({ ...address, taskId: 'unrelated' }))
      expect(predict).toHaveBeenCalledTimes(1)
    }
  )

  it('uses chat scope without a workspace path and keeps the session model', async () => {
    const { store, predict, fixture, start, finish } = setup()
    const chat = { ...address, workspacePath: undefined, workspaceKind: 'chat' }
    const modelSelection = { modelName: 'session-model', modelType: 'runtime' as const }
    store.syncRuntimeTask(chat, {
      taskId: chat.taskId,
      title: 'Chat',
      runtime: 'codex',
      workspacePath: '',
      workspaceKind: 'chat',
      modelSelection,
    })
    render(fixture())
    act(() => {
      start(chat)
      finish(chat)
    })
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    expect(predict).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection,
        address: expect.objectContaining({ workspaceKind: 'chat' }),
      })
    )
  })

  it('shares chat results when the route address omits the workspace kind', async () => {
    const { store, predict, fixture, start, finish } = setup()
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      title: 'Chat',
      runtime: 'codex',
      workspacePath: address.workspacePath!,
      workspaceKind: 'chat',
    })
    const view = render(fixture())
    act(() => {
      start()
      finish()
    })
    await waitFor(() => expect(predict).toHaveBeenCalledTimes(1))
    view.rerender(fixture({ composer: true }))
    await waitFor(() => expect(screen.getByText('请继续验证')).toBeVisible())
    expect(predict).toHaveBeenCalledTimes(1)
  })
})
