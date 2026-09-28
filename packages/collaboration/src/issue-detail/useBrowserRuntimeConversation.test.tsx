// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { TurnFileChangesSummary } from '@wegent/chat-core/runtime'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { useBrowserRuntimeConversation } from './useBrowserRuntimeConversation'
import { createCollaborationTranslator } from '../i18n'

const address = { deviceId: 'task-device', taskId: 'original-task' }
const artifact: TurnFileChangesSummary = {
  version: 1,
  status: 'active',
  artifact_id: 'artifact-1',
  device_id: 'artifact-device',
  workspace_path: '/original/repo',
  file_count: 0,
  additions: 0,
  deletions: 0,
  files: [],
}
const translate = createCollaborationTranslator('zh-CN')

describe('browser binding for shared runtime file actions', () => {
  let root: Root
  let container: HTMLDivElement
  let runtime: SharedWorkspaceRuntimeApi
  let viewer: ReturnType<typeof useBrowserRuntimeConversation>
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    runtime = {
      executeCommand: vi
        .fn()
        .mockResolvedValue({ success: true, stdout: { success: true, diff: 'actual diff' } }),
      fileChangesFromError: () => undefined,
      listDevices: vi.fn().mockResolvedValue([]),
      subscribeChatStream: vi.fn().mockResolvedValue(() => {}),
      work: {
        createRuntimeTask: vi.fn(),
        listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [] }),
        sendRuntimeMessage: vi.fn(),
        guideRuntimeTask: vi.fn(),
        interruptAndSendRuntimeMessage: vi.fn(),
        cancelRuntimeTask: vi.fn(),
        getRuntimeGoal: vi.fn(),
        revertRuntimeFileChanges: vi
          .fn()
          .mockResolvedValue({ fileChanges: { ...artifact, status: 'reverted' } }),
      },
      listModels: vi.fn(),
      uploadAttachment: vi.fn(),
      deleteAttachment: vi.fn(),
      readAttachment: vi.fn(),
      readWorkspaceFile: vi.fn(),
      openModelSettings: vi.fn(),
      getTranscript: vi
        .fn()
        .mockResolvedValue({
          runtime: 'codex',
          workspacePath: '/original/repo',
          running: false,
          messages: [],
          turns: [
            {
              id: 'turn-1',
              status: 'done',
              fileChanges: artifact,
              items: [
                {
                  id: 'text-1',
                  type: 'assistant_text',
                  content: 'Updated files',
                  createdAt: '2026-09-17T00:00:00Z',
                },
              ],
            },
          ],
        }),
      subscribe: vi.fn().mockResolvedValue(() => {}),
      cancel: vi.fn(),
      dispose: vi.fn(),
    }
    function Harness() {
      viewer = useBrowserRuntimeConversation(runtime, address, translate)
      return null
    }
    await act(async () => root.render(<Harness />))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  it('loads the card artifact diff and keeps the reverted state through history refresh', async () => {
    const subtaskId = viewer.state.messages[0].subtaskId!
    expect(await viewer.conversation.onLoadFileChangesDiff(subtaskId)).toBe('actual diff')
    expect(runtime.executeCommand).toHaveBeenCalledWith(
      'artifact-device',
      expect.objectContaining({ path: '/original/repo', args: ['artifact-1'] })
    )
    await act(async () => {
      await viewer.conversation.onRevertFileChanges(subtaskId)
    })
    expect(runtime.work.revertRuntimeFileChanges).toHaveBeenCalledWith({
      address,
      fileChanges: artifact,
    })
    expect(viewer.state.messages[0].fileChanges?.status).toBe('reverted')
    await act(async () => {
      await viewer.reload()
    })
    expect(viewer.state.messages[0].fileChanges?.status).toBe('reverted')
  })
  it('uses an explicit card artifact and publishes conflict results without marking them reverted', async () => {
    const subtaskId = viewer.state.messages[0].subtaskId!
    const card = { ...artifact, diff: 'card diff' }
    expect(await viewer.conversation.onLoadFileChangesDiff(subtaskId, card)).toBe('card diff')
    expect(runtime.executeCommand).not.toHaveBeenCalled()
    vi.mocked(runtime.work.revertRuntimeFileChanges).mockRejectedValueOnce(
      new Error('Working tree changed')
    )
    runtime.fileChangesFromError = () => ({ ...artifact, status: 'conflicted' })
    // The adapter is supplied before the next user action through a host rerender.
    await act(async () => {
      await viewer.reload()
    })
    await act(async () => {
      expect(await viewer.conversation.onRevertFileChanges(subtaskId, card)).toMatchObject({
        status: 'conflicted',
        diff: 'card diff',
      })
    })
    expect(viewer.state.messages[0].fileChanges?.status).toBe('conflicted')
  })
  it('leaves the canonical artifact intact and surfaces transport failures', async () => {
    const subtaskId = viewer.state.messages[0].subtaskId!
    vi.mocked(runtime.work.revertRuntimeFileChanges).mockRejectedValueOnce(
      new Error('Device offline')
    )
    await expect(viewer.conversation.onRevertFileChanges(subtaskId)).rejects.toThrow(
      'Device offline'
    )
    expect(viewer.state.messages[0].fileChanges?.status).toBe('active')
  })
})
