// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import fileViewerPackage from '@file-viewer/react/package.json'
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
      docx: { workerUrl: string; workerJsZipUrl: string }
      spreadsheet: { workerUrl: string }
      presentation: { workerUrl: string }
    }

    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('deck.pptx')
    expect(props.type).toBe('pptx')
    expect(props.className).toContain('overflow-auto')
    expect(options.styleIsolation).toBe('scoped')
    expect(options).not.toHaveProperty('pdf')
    const assetBase = `/file-viewer/${fileViewerPackage.version}-office-v2/`
    expect(options.docx.workerUrl).toBe(`${assetBase}vendor/docx/docx.worker.js`)
    expect(options.docx.workerJsZipUrl).toBe(`${assetBase}vendor/docx/jszip.min.js`)
    expect(options.spreadsheet.workerUrl).toBe(`${assetBase}vendor/xlsx/sheet.worker.js`)
    expect(options.presentation.workerUrl).toBe(`${assetBase}vendor/pptx/pptx.worker.js`)
  })

  it('routes PowerPoint files to the shared Office preview', () => {
    const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

    expect(isFilePreviewable(mimeType, 'deck.pptx')).toBe(true)
    expect(getPreviewType(mimeType, 'deck.pptx')).toBe('office')
  })

  it.each([
    ['application/vnd.ms-powerpoint', 'deck.ppt'],
    ['application/vnd.ms-powerpoint', 'deck.pptx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.ppt'],
  ])('rejects legacy PowerPoint input (%s, %s)', (mimeType, filename) => {
    expect(isFilePreviewable(mimeType, filename)).toBe(false)
    expect(getPreviewType(mimeType, filename)).toBe('unknown')
  })

  it.each(['doc', 'docx'])(
    'exposes the %s scroll container to the dialog scroll lock',
    extension => {
      render(
        <FlyfishOfficePreview
          blob={new Blob(['document'], { type: 'application/octet-stream' })}
          filename={`report.${extension}`}
        />
      )

      const props = mockFileViewer.mock.calls[0][0]
      expect(props.className).not.toContain('overflow-auto')
      expect((props.options as { styleIsolation: string }).styleIsolation).toBe('scoped')
    }
  )

  it('keeps spreadsheets isolated in Shadow DOM without an outer scroll container', () => {
    render(
      <FlyfishOfficePreview
        blob={new Blob(['spreadsheet'], { type: 'application/octet-stream' })}
        filename="report.xlsx"
      />
    )

    const props = mockFileViewer.mock.calls[0][0]
    expect(props.className).not.toContain('overflow-auto')
    expect((props.options as { styleIsolation: string }).styleIsolation).toBe('shadow')
  })
})
