// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { FlyfishOfficePreview } from '@/components/common/FilePreview/preview-renderers/FlyfishOfficePreview'
import { getPreviewType, isFilePreviewable } from '@/components/common/FilePreview/utils'

const mockFileViewer = jest.fn((props: Record<string, unknown>) => (
  <div data-testid="mock-flyfish-office-viewer">{String(props.filename)}</div>
))

jest.mock('@file-viewer/react', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockFileViewer(props),
}))

jest.mock('@file-viewer/preset-office', () => ({
  __esModule: true,
  default: ['office-renderers'],
}))

describe('FlyfishOfficePreview', () => {
  beforeEach(() => {
    mockFileViewer.mockClear()
  })

  it('wraps a blob as a named File and uses versioned local workers', () => {
    render(
      <FlyfishOfficePreview
        blob={new Blob(['slides'], { type: 'application/octet-stream' })}
        filename="deck.pptx"
      />
    )

    expect(screen.getByTestId('mock-flyfish-office-viewer')).toHaveTextContent('deck.pptx')
    const props = mockFileViewer.mock.calls[0][0]
    const file = props.file as File
    const options = props.options as {
      styleIsolation: string
      docx: { workerUrl: string }
      spreadsheet: { workerUrl: string }
      presentation: { workerUrl: string }
    }

    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('deck.pptx')
    expect(props.type).toBe('pptx')
    expect(props.className).toContain('overflow-auto')
    expect(options.styleIsolation).toBe('scoped')
    expect(options.docx.workerUrl).toContain('/file-viewer/2.1.27-office-v2/')
    expect(options.spreadsheet.workerUrl).toContain('/file-viewer/2.1.27-office-v2/')
    expect(options.presentation.workerUrl).toContain('/file-viewer/2.1.27-office-v2/')
  })

  it('routes PowerPoint files to the shared Office preview', () => {
    const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

    expect(isFilePreviewable(mimeType, 'deck.pptx')).toBe(true)
    expect(getPreviewType(mimeType, 'deck.pptx')).toBe('office')
  })

  it('keeps Word files on the renderer-owned scroll container', () => {
    render(
      <FlyfishOfficePreview
        blob={new Blob(['document'], { type: 'application/octet-stream' })}
        filename="report.docx"
      />
    )

    const props = mockFileViewer.mock.calls[0][0]
    expect(props.className).not.toContain('overflow-auto')
    expect((props.options as { styleIsolation: string }).styleIsolation).toBe('shadow')
  })

  it('does not add the page scroll container to spreadsheets', () => {
    render(
      <FlyfishOfficePreview
        blob={new Blob(['spreadsheet'], { type: 'application/octet-stream' })}
        filename="report.xlsx"
      />
    )

    expect(mockFileViewer.mock.calls[0][0].className).not.toContain('overflow-auto')
  })
})
