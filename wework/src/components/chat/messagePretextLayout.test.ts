import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  clearMessagePretextLayoutCache,
  getMessagePretextIntrinsicHeight,
} from './messagePretextLayout'
import { layout, prepare } from '@chenglou/pretext'

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string, font: string, options: unknown) => ({ text, font, options })),
  layout: vi.fn((_prepared: unknown, _width: number, lineHeight: number) => ({
    height: lineHeight * 3,
    lineCount: 3,
  })),
}))

const mockedPrepare = vi.mocked(prepare)
const mockedLayout = vi.mocked(layout)

describe('messagePretextLayout', () => {
  beforeEach(() => {
    clearMessagePretextLayoutCache()
    mockedPrepare.mockImplementation((text: string, font: string, options: unknown) => ({
      text,
      font,
      options,
    }))
    mockedLayout.mockImplementation((_prepared: unknown, _width: number, lineHeight: number) => ({
      height: lineHeight * 3,
      lineCount: 3,
    }))
    vi.clearAllMocks()
  })

  test('uses Pretext to estimate assistant text height', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Assistant answer\nwith two lines',
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    const height = getMessagePretextIntrinsicHeight(message, 500)

    expect(mockedPrepare).toHaveBeenCalledWith(
      message.content,
      expect.stringContaining('13px Inter'),
      { whiteSpace: 'pre-wrap' }
    )
    expect(mockedLayout).toHaveBeenCalledWith(expect.anything(), 512, 24)
    expect(height).toBe(104)
  })

  test('reuses cached measurements inside the same width bucket', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-cached',
      role: 'assistant',
      content: 'Repeated assistant answer',
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(104)
    expect(getMessagePretextIntrinsicHeight(message, 511)).toBe(104)

    expect(mockedPrepare).toHaveBeenCalledTimes(1)
    expect(mockedLayout).toHaveBeenCalledTimes(1)
  })

  test('caps collapsed user text while keeping room for the collapse button', () => {
    mockedLayout.mockReturnValueOnce({ height: 260, lineCount: 13 })
    const message: WorkbenchMessage = {
      id: 'user-1',
      role: 'user',
      content: Array.from({ length: 12 }, (_, index) => `Line ${index}`).join('\n'),
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    const height = getMessagePretextIntrinsicHeight(message, 500)

    expect(mockedLayout).toHaveBeenCalledWith(expect.anything(), 377, 20)
    expect(height).toBe(244)
  })

  test('adds attachment space for user messages', () => {
    mockedLayout.mockReturnValueOnce({ height: 20, lineCount: 1 })
    const attachment: Attachment = {
      id: 1,
      filename: 'notes.pdf',
      file_size: 1024,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-07-02T10:00:00Z',
    }
    const message: WorkbenchMessage = {
      id: 'user-attachment',
      role: 'user',
      content: 'see attachment',
      status: 'done',
      attachments: [attachment],
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(98)
  })

  test('does not run Pretext for empty failed assistant messages', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-failed',
      role: 'assistant',
      content: '',
      status: 'failed',
      error: 'network down',
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(148)
    expect(mockedPrepare).not.toHaveBeenCalled()
    expect(mockedLayout).not.toHaveBeenCalled()
  })

  test('falls back to arithmetic text height when Pretext measurement fails', () => {
    mockedPrepare.mockImplementationOnce(() => {
      throw new Error('canvas unavailable')
    })
    const message: WorkbenchMessage = {
      id: 'assistant-fallback',
      role: 'assistant',
      content: 'x'.repeat(200),
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 140)).toBe(272)
  })

  test('uses a stable intrinsic height without measuring streaming messages', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-streaming',
      role: 'assistant',
      content: 'x'.repeat(20_000),
      status: 'streaming',
      createdAt: '2026-07-10T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(220)
    expect(mockedPrepare).not.toHaveBeenCalled()
    expect(mockedLayout).not.toHaveBeenCalled()
  })

  test('measures fenced code by its rendered lines instead of wrapping it', () => {
    const code = Array.from(
      { length: 10 },
      (_, index) => `const line${index} = '${'x'.repeat(160)}'`
    )
    const message: WorkbenchMessage = {
      id: 'assistant-code',
      role: 'assistant',
      content: ['Intro', '', '```ts', ...code, '```', '', 'Outro'].join('\n'),
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    // Two prose segments at the mocked three lines each, plus ten unwrapped code lines and the
    // code block's own chrome — plus the assistant row's hover action and vertical buffer.
    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(2 * 72 + 10 * 22 + 84 + 32)
    expect(mockedPrepare).toHaveBeenCalledTimes(2)
    for (const [text] of mockedPrepare.mock.calls) {
      expect(text).not.toContain('const line0')
    }
  })

  test('treats an unclosed fence as code until the end of the message', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-unclosed-fence',
      role: 'assistant',
      content: ['Before', '```', 'one', 'two', ''].join('\n'),
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(72 + 2 * 22 + 84 + 32)
  })

  test('closes a fence only with its own marker', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-fence-marker',
      role: 'assistant',
      content: ['~~~~', '```', 'inner', '~~~~', 'After'].join('\n'),
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(72 + 2 * 22 + 84 + 32)
    expect(mockedPrepare).toHaveBeenCalledTimes(1)
    expect(mockedPrepare.mock.calls[0]?.[0]).toContain('After')
  })

  test('keeps inline code in the wrapped prose measurement', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-inline-code',
      role: 'assistant',
      content: 'Run `pnpm test` and ``pnpm lint`` before pushing',
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(104)
    expect(mockedPrepare).toHaveBeenCalledTimes(1)
  })

  test('budgets a collapsed process section once, however many blocks a turn holds', () => {
    const blocks = Array.from({ length: 54 }, (_, index) => ({
      id: `tool-${index}`,
      subtaskId: 'turn-1',
      type: 'tool' as const,
      toolName: 'shell',
      status: 'done' as const,
      createdAt: 1,
    }))
    const manyBlocks: WorkbenchMessage = {
      id: 'assistant-many-blocks',
      role: 'assistant',
      content: 'Done',
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
      blocks,
    }
    const oneBlock: WorkbenchMessage = {
      ...manyBlocks,
      id: 'assistant-one-block',
      blocks: blocks.slice(0, 1),
    }

    // Prose (mocked at three lines) plus one collapsed summary row and the assistant row's own hover
    // action and vertical buffer — the block count no longer adds height of its own.
    expect(getMessagePretextIntrinsicHeight(manyBlocks, 500)).toBe(72 + 44 + 32)
    expect(getMessagePretextIntrinsicHeight(oneBlock, 500)).toBe(72 + 44 + 32)
  })

  test('adds nothing for a turn that ran no blocks', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-no-blocks',
      role: 'assistant',
      content: 'Done',
      status: 'done',
      createdAt: '2026-07-02T10:00:00Z',
      blocks: [],
    }

    expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(72 + 32)
  })
})
