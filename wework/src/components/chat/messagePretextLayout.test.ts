// @vitest-environment node

import type { WorkbenchMessage } from '@/types/workbench'
import { layout, prepare } from '@chenglou/pretext'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readMessageLayoutTypography } from '../../../../packages/collaboration/src/conversation/messagePretextLayout'
import {
  clearMessagePretextLayoutCache,
  getMessagePretextIntrinsicHeight,
} from './messagePretextLayout'

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

  test.each(['mermaid'])(
    'estimates %s by the fixed preview geometry regardless of source length',
    language => {
      for (const count of [2, 100]) {
        const message: WorkbenchMessage = {
          id: `${language}-${count}`,
          role: 'assistant',
          status: 'done',
          createdAt: '',
          content: [
            `\`\`\`${language}`,
            ...Array.from({ length: count }, () => 'A --> B'),
            '```',
          ].join('\n'),
        }
        expect(getMessagePretextIntrinsicHeight(message, 500)).toBe(404 + 32)
        expect(
          getMessagePretextIntrinsicHeight(message, 500, {
            ...readMessageLayoutTypography(),
            rootFontSize: 20,
          })
        ).toBe(505 + 32)
      }
    }
  )
})
