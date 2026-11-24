// @vitest-environment jsdom
import { act, createRef, useImperativeHandle, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeWorkListResponse } from '@wegent/chat-core/runtime-task-api-types'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { createCollaborationTranslator } from '../i18n'
import { useBrowserRuntimeConversation } from './useBrowserRuntimeConversation'

type Viewer = ReturnType<typeof useBrowserRuntimeConversation>
const translate = createCollaborationTranslator('zh-CN')
const address = { deviceId: 'device', taskId: 'first' }
const result = createRef<Viewer>()
let root: Root
let container: HTMLDivElement
function work(taskId = 'first', title = taskId): RuntimeWorkListResponse {
  return {
    totalTasks: 1,
    projects: [],
    chats: [
      {
        deviceId: 'device',
        available: true,
        workspacePath: '/work',
        tasks: [{ taskId, title, runtime: 'codex', workspacePath: '/work' }],
      },
    ],
  }
}
function deferred() {
  let resolve!: (value: RuntimeWorkListResponse) => void
  const promise = new Promise<RuntimeWorkListResponse>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function fixture() {
  const listRuntimeWork = vi
    .fn<SharedWorkspaceRuntimeApi['work']['listRuntimeWork']>()
    .mockResolvedValue(work())
  const getTranscript = vi
    .fn()
    .mockResolvedValue({ runtime: 'codex', running: false, messages: [], turns: [] })
  const runtime = {
    work: { listRuntimeWork },
    getTranscript,
    subscribe: vi.fn().mockResolvedValue(() => {}),
    subscribeChatStream: vi.fn().mockResolvedValue(() => {}),
  } as unknown as SharedWorkspaceRuntimeApi
  return { runtime, listRuntimeWork, getTranscript }
}
function Harness({
  runtime,
  target = address,
  ref,
}: {
  runtime: SharedWorkspaceRuntimeApi
  target?: RuntimeTaskAddress
  ref: Ref<Viewer>
}) {
  const viewer = useBrowserRuntimeConversation(runtime, target, translate)
  useImperativeHandle(ref, () => viewer, [viewer])
  return null
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

test('equivalent addresses reuse metadata and explicit reload refreshes both sources', async () => {
  const f = fixture()
  await act(async () => root.render(<Harness runtime={f.runtime} ref={result} />))
  expect(result.current?.task?.title).toBe('first')
  await act(async () =>
    root.render(<Harness runtime={f.runtime} target={{ ...address }} ref={result} />)
  )
  expect(f.listRuntimeWork).toHaveBeenCalledTimes(1)
  const transcriptReads = f.getTranscript.mock.calls.length
  f.listRuntimeWork.mockResolvedValueOnce(work('first', 'Refreshed'))
  await act(async () => {
    await result.current!.reload()
  })
  expect(f.listRuntimeWork).toHaveBeenCalledTimes(2)
  expect(f.getTranscript).toHaveBeenCalledTimes(transcriptReads + 1)
  expect(result.current?.task?.title).toBe('Refreshed')
})

test('task changes abort old metadata and ignore a transport that completes after abort', async () => {
  const f = fixture(),
    pending = deferred()
  f.listRuntimeWork.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(work('second'))
  await act(async () => root.render(<Harness runtime={f.runtime} ref={result} />))
  const signal = f.listRuntimeWork.mock.calls[0][0]?.signal
  await act(async () =>
    root.render(
      <Harness runtime={f.runtime} target={{ ...address, taskId: 'second' }} ref={result} />
    )
  )
  expect(signal?.aborted).toBe(true)
  expect(result.current?.task?.taskId).toBe('second')
  await act(async () => pending.resolve(work()))
  expect(result.current?.task?.taskId).toBe('second')
  expect(result.current?.workspace?.workspacePath).toBe('/work')
})

test('runtime ownership isolates a late response for an identical task address', async () => {
  const old = fixture(),
    next = fixture(),
    pending = deferred()
  old.listRuntimeWork.mockReturnValueOnce(pending.promise)
  next.listRuntimeWork.mockResolvedValueOnce(work('first', 'New owner'))
  await act(async () => root.render(<Harness runtime={old.runtime} ref={result} />))
  await act(async () => root.render(<Harness runtime={next.runtime} ref={result} />))
  await act(async () => pending.resolve(work('first', 'Old owner')))
  expect(result.current?.task?.title).toBe('New owner')
})

test('metadata errors preserve the conversation and retry only on explicit refresh', async () => {
  const f = fixture()
  f.listRuntimeWork.mockRejectedValueOnce(new Error('Work offline'))
  await act(async () => root.render(<Harness runtime={f.runtime} ref={result} />))
  expect(result.current?.metadataError).toBe('Work offline')
  expect(result.current?.task).toBeNull()
  expect(result.current?.state.loading).toBe(false)
  expect(result.current?.state.error).toBeNull()
  expect(f.listRuntimeWork).toHaveBeenCalledTimes(1)
  await act(async () => {
    await result.current!.reload()
  })
  expect(result.current?.metadataError).toBeNull()
  expect(result.current?.task?.taskId).toBe('first')
})

test('detaching a pending viewer aborts metadata and a fresh viewer can load', async () => {
  const f = fixture(),
    pending = deferred()
  f.listRuntimeWork.mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<Harness runtime={f.runtime} ref={result} />))
  const signal = f.listRuntimeWork.mock.calls[0][0]?.signal
  await act(async () => root.render(null))
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve(work('first', 'Detached')))
  await act(async () => root.render(<Harness runtime={f.runtime} ref={result} />))
  expect(result.current?.task?.title).toBe('first')
})
