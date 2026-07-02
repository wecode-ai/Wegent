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
})
