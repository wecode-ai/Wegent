import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatProcessingBlock } from '@/types/runtime'
import { ProcessingTimeline } from './ProcessingTimeline'
import { FilePreviewContext, type MobileFilePreviewActions } from './files/FilePreviewContext'
import { ConversationFollowingContext } from './useConversationReading'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const markdownRenders = vi.hoisted(() => vi.fn())
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
vi.mock('./AssistantMarkdown', () => ({
  AssistantMarkdown: (props: { children: string }) => {
    markdownRenders(props.children)
    return React.createElement('Markdown', props)
  },
}))
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

describe('ProcessingTimeline streaming ownership', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = undefined
  })
  const tool = (id: string, status: 'streaming' | 'done'): ChatProcessingBlock => ({
    id,
    type: 'tool',
    subtaskId: 'turn',
    toolName: 'exec_command',
    toolInput: { cmd: 'pwd' },
    status,
    createdAt: 1,
  })
  const message = (blocks: ChatProcessingBlock[], content = ''): ChatMessage => ({
    id: 'message',
    role: 'assistant',
    status: 'streaming',
    content,
    blocks,
    createdAt: 1,
  })
  const nodes = (testID: string) => renderer!.root.findAllByProps({ testID })
  const update = async (next: ChatMessage, following = true) => {
    await act(() => {
      const element = (
        <ConversationFollowingContext.Provider value={following}>
          <ProcessingTimeline message={next} />
        </ConversationFollowingContext.Provider>
      )
      if (renderer) renderer.update(element)
      else renderer = create(element)
    })
  }

  it('does not mistake streaming commentary between tools for a completed turn', async () => {
    const first = tool('first', 'done')
    await update(message([first]))
    const segment = nodes('processing-tool-segment')[0]

    await update(message([first], '接下来检查目录。'))
    expect(nodes('completed-processing-message')).toHaveLength(0)
    expect(nodes('processing-tool-segment')[0] === segment).toBe(true)

    await update(
      message([
        first,
        {
          id: 'commentary',
          subtaskId: 'turn',
          type: 'text',
          content: '接下来检查目录。',
          status: 'done',
          createdAt: 2,
        },
        tool('next', 'streaming'),
      ])
    )
    expect(nodes('processing-tool-segment')[0] === segment).toBe(true)
    expect(nodes('processing-timeline-message')).toHaveLength(1)
  })

  it('keeps the active preview mounted between consecutive tool calls', async () => {
    await update(message([tool('first', 'streaming')]))
    const segment = nodes('processing-tool-segment')[0]
    const details = nodes('processing-segment-details')[0]

    await update(message([tool('first', 'done')]))
    expect(nodes('processing-tool-segment')[0] === segment).toBe(true)
    expect(nodes('processing-segment-details')[0] === details).toBe(true)

    await update(message([tool('first', 'done'), tool('second', 'streaming')]))
    expect(nodes('processing-tool-segment')[0] === segment).toBe(true)
    expect(nodes('processing-segment-details')[0] === details).toBe(true)

    await update(message([tool('first', 'done'), tool('second', 'done')]))
    expect(nodes('processing-tool-segment')[0] === segment).toBe(true)
    expect(nodes('processing-segment-details')[0] === details).toBe(true)
  })

  it('preserves explicit expansion through added tools and the completed turn summary', async () => {
    const first = tool('first', 'done')
    await update(message([first]))
    await act(() => nodes('processing-segment-toggle')[0]!.props.onPress())
    const details = nodes('processing-segment-details')[0]

    await update(message([first, tool('second', 'done')]))
    expect(nodes('processing-segment-details')[0] === details).toBe(true)

    await update({ ...message([first, tool('second', 'done')], '完成。'), status: 'completed' })
    expect(nodes('completed-processing-message')).toHaveLength(1)
    expect(
      nodes('completed-processing-content-message')[0]!.props.accessibilityElementsHidden
    ).toBe(true)
    await act(() => nodes('completed-processing-toggle-message')[0]!.props.onPress())
    expect(
      nodes('completed-processing-content-message')[0]!.props.accessibilityElementsHidden
    ).toBe(false)
    expect(nodes('processing-segment-details')[0] === details).toBe(true)
  })

  it('does not reopen a collapsed tool group when the next tool joins it', async () => {
    const first = tool('first', 'done')
    await update(message([first]))
    const groupToggle = () =>
      renderer!.root.findAll(
        node =>
          node.type === ('Pressable' as never) &&
          node.props.testID?.startsWith('tool-group-toggle-')
      )[0]!
    const toggle = groupToggle()
    await act(() => toggle.props.onPress())
    const groupDetails = () =>
      renderer!.root.findAll(node => node.props.testID?.startsWith('tool-group-details-'))
    expect(groupDetails()).toHaveLength(0)

    await update(message([first, tool('second', 'done')]))
    expect(groupToggle() === toggle).toBe(true)
    expect(groupDetails()).toHaveLength(0)
  })

  it('defers completion collapse while browsing and applies it on returning to the end', async () => {
    await update(message([tool('first', 'streaming')]))
    const completed = {
      ...message([tool('first', 'done')], '完成。'),
      status: 'completed' as const,
    }
    await update(completed, false)
    expect(nodes('processing-timeline-message')).toHaveLength(1)
    expect(nodes('processing-segment-details')).toHaveLength(1)

    await update(completed, true)
    expect(
      nodes('completed-processing-content-message')[0]!.props.accessibilityElementsHidden
    ).toBe(true)
    await update(completed, false)
    expect(
      nodes('completed-processing-content-message')[0]!.props.accessibilityElementsHidden
    ).toBe(true)

    await act(() => nodes('completed-processing-toggle-message')[0]!.props.onPress())
    expect(
      nodes('completed-processing-content-message')[0]!.props.accessibilityElementsHidden
    ).toBe(false)
  })

  it('holds the live tool preview while reading when commentary arrives', async () => {
    await update(message([tool('first', 'streaming')]), false)
    const commentary = message([tool('first', 'done')], '现在解释结果。')
    await update(commentary, false)
    expect(nodes('processing-segment-details')).toHaveLength(1)
    await update(commentary, true)
    expect(nodes('processing-segment-details')).toHaveLength(0)
  })

  it('does not rerender completed narrative blocks when only the reply tail changes', async () => {
    const blocks: ChatProcessingBlock[] = [
      {
        id: 'intro',
        type: 'text',
        subtaskId: 'turn',
        status: 'done',
        createdAt: 1,
        content: 'Stable introduction',
      },
      tool('first', 'done'),
    ]
    await update(message(blocks, 'Tail'))
    markdownRenders.mockClear()
    await update(message(blocks, 'Tail with additional text'))
    expect(markdownRenders).not.toHaveBeenCalled()
    const changed = [{ ...blocks[0]!, content: 'Corrected introduction' }, blocks[1]!]
    await update(message(changed, 'Tail with additional text'))
    expect(markdownRenders).toHaveBeenCalledWith('Corrected introduction')
  })
})
