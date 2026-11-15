import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatProcessingBlock } from '@/types/runtime'
import { ProcessingTimeline } from './ProcessingTimeline'
import { FilePreviewContext, type MobileFilePreviewActions } from './files/FilePreviewContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ colors: { onSurfaceVariant: '#888' } }),
}))
vi.mock('./AssistantMarkdown', () => ({ AssistantMarkdown: 'Markdown' }))
vi.mock('./RequestUserInputCard', () => ({ RequestUserInputCard: 'Input' }))

describe('ProcessingTimeline file preview entry points', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  const button = (id: string) =>
    renderer.root.findAll(
      node => node.type === ('Pressable' as never) && node.props.testID === id
    )[0]!
  async function render(
    blocks: ChatProcessingBlock[],
    preview: Partial<MobileFilePreviewActions> | null
  ) {
    const message: ChatMessage = {
      id: 'message',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: 1,
      blocks,
    }
    await act(() => {
      renderer = create(
        <FilePreviewContext.Provider value={preview as MobileFilePreviewActions | null}>
          <ProcessingTimeline message={message} />
        </FilePreviewContext.Provider>
      )
    })
  }
  const tool = (overrides: Record<string, unknown>): ChatProcessingBlock => ({
    id: 'read',
    type: 'tool',
    subtaskId: 'turn',
    toolName: 'read_file',
    status: 'done',
    createdAt: 1,
    ...overrides,
  })

  it.each([true, false])(
    'opens tool file paths only for a resolved workspace (%s)',
    async available => {
      const openWorkspaceFile = vi.fn()
      await render([tool({ toolInput: { file_path: 'src/main.ts' } })], {
        target: available ? { deviceId: 'device', path: '/work' } : null,
        openWorkspaceFile,
      })
      await act(() => button('processing-segment-toggle').props.onPress())
      const path = button('tool-file-preview-read-src/main.ts')
      expect(path.props.disabled).toBe(!available)
      if (available) await act(() => path.props.onPress())
      expect(openWorkspaceFile).toHaveBeenCalledTimes(available ? 1 : 0)
    }
  )

  it.each([true, false])(
    'opens artifact diffs and plain tool paths through separate data sources (%s)',
    async sourceAvailable => {
      const source = {
        version: 1 as const,
        status: 'active' as const,
        artifact_id: 'diff',
        device_id: 'storage',
        workspace_path: '/original',
        file_count: 1,
        additions: 1,
        deletions: 0,
        files: [
          {
            path: 'a.ts',
            change_type: 'modified' as const,
            additions: 1,
            deletions: 0,
            binary: false,
          },
        ],
      }
      const openChanges = vi.fn(),
        openWorkspaceFile = vi.fn()
      await render(
        [
          {
            id: 'changes',
            type: 'file_changes',
            subtaskId: 'turn',
            status: 'done',
            createdAt: 1,
            fileChanges: {
              fileCount: 1,
              additions: 1,
              deletions: 0,
              files: [
                { path: 'a.ts', changeType: 'modified', additions: 1, deletions: 0, binary: false },
              ],
              ...(sourceAvailable ? { source } : {}),
            },
          },
        ],
        { target: { deviceId: 'device', path: '/work' }, openChanges, openWorkspaceFile }
      )
      await act(() => button('processing-segment-toggle').props.onPress())
      await act(() => button('file-changes-activity-toggle-changes').props.onPress())
      await act(() => button('process-file-preview-changes-a.ts').props.onPress())
      if (sourceAvailable) {
        expect(openChanges).toHaveBeenCalledWith(source, 'a.ts')
        expect(openWorkspaceFile).not.toHaveBeenCalled()
      } else {
        expect(openWorkspaceFile).toHaveBeenCalledWith('a.ts')
        expect(openChanges).not.toHaveBeenCalled()
      }
    }
  )

  it('opens inline image bytes without treating them as device file paths', async () => {
    const openFile = vi.fn()
    await render(
      [
        tool({
          toolName: 'image_generation',
          renderPayload: { imageBase64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
        }),
      ],
      { target: null, openFile }
    )
    await act(() => button('generated-image-preview-read').props.onPress())
    expect(openFile).toHaveBeenCalledWith({
      kind: 'image',
      dataUri: 'data:image/jpeg;base64,aW1hZ2U=',
      name: 'generated-image-1.jpg',
    })
  })

  it('opens generated workspace images using their own device and workspace', async () => {
    const openAttachment = vi.fn()
    await render(
      [
        tool({
          toolName: 'image_generation',
          renderPayload: {
            source: {
              type: 'workspace_file',
              deviceId: 'original-device',
              workspacePath: '/original',
              path: 'image.webp',
            },
            mimeType: 'image/webp',
            size: 70,
            width: 20,
            height: 30,
          },
        }),
      ],
      { target: null, openAttachment }
    )
    await act(() => button('generated-image-preview-read').props.onPress())
    expect(openAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        mime_type: 'image/webp',
        file_size: 70,
        image_width: 20,
        image_height: 30,
        workspace_file: {
          device_id: 'original-device',
          workspace_path: '/original',
          path: 'image.webp',
        },
      })
    )
  })

  it('disables image preview without a provider and does not invent a preview for invalid artifacts', async () => {
    await render(
      [
        tool({ toolName: 'image_generation', renderPayload: { imageBase64: 'aW1hZ2U=' } }),
        tool({
          id: 'invalid',
          toolName: 'image_generation',
          renderPayload: { source: { type: 'workspace_file', path: 'missing-device.png' } },
        }),
      ],
      null
    )
    expect(button('generated-image-preview-read').props.disabled).toBe(true)
    expect(button('generated-image-preview-invalid')).toBeUndefined()
  })
})
