// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import fileViewerPackage from '@file-viewer/react/package.json'
import { act, render, screen } from '@testing-library/react'
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

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
        restricted
      />
    )

    expect(screen.getByTestId('mock-flyfish-office-viewer')).toHaveTextContent('deck.pptx')
    const props = mockFileViewer.mock.calls[0][0]
    const file = props.file as File
    const options = props.options as {
      styleIsolation: string
      toolbar: {
        download: boolean
        print: boolean
        exportHtml: boolean
        permissions: Record<string, boolean>
      }
      pdf: { workerUrl: string; cMapUrl: string; wasmUrl: string }
      docx: { workerUrl: string; workerJsZipUrl: string }
      spreadsheet: { workerUrl: string }
      presentation: { workerUrl: string }
    }

    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('deck.pptx')
    expect(props.type).toBe('pptx')
    expect(props.className).toContain('overflow-auto')
    expect(options.styleIsolation).toBe('scoped')
    expect(options.toolbar).toMatchObject({
      download: false,
      print: false,
      exportHtml: false,
      permissions: { download: false, print: false, 'export-html': false },
    })
    const assetBase = `/file-viewer/${fileViewerPackage.version}-office-pdf-v3/`
    expect(options.pdf.workerUrl).toBe(`${assetBase}vendor/pdf/pdf.worker.mjs`)
    expect(options.pdf.cMapUrl).toBe(`${assetBase}vendor/pdf/cmaps/`)
    expect(options.pdf.wasmUrl).toBe(`${assetBase}vendor/pdf/wasm/`)
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

  it('keeps the existing toolbar behavior for non-restricted callers', () => {
    render(
      <FlyfishOfficePreview
        blob={new Blob(['document'], { type: 'application/octet-stream' })}
        filename="report.docx"
      />
    )

    const options = mockFileViewer.mock.calls[0][0].options as {
      toolbar: Record<string, unknown>
    }
    expect(options.toolbar).not.toHaveProperty('print')
    expect(options.toolbar).not.toHaveProperty('permissions')
  })

  it('streams a remote PDF without requiring a full Blob', () => {
    render(
      <FlyfishOfficePreview
        url="https://cdn.example.com/large.pdf"
        filename="large.pdf"
        restricted
        coverOnly
      />
    )

    const props = mockFileViewer.mock.calls[0][0]
    const options = props.options as {
      toolbar: boolean
      pdf: {
        toolbar: boolean
        navigation: boolean
        thumbnails: boolean
        streaming: boolean
        rangeChunkSize: number
        withCredentials: boolean
      }
    }
    expect(props.url).toBe('https://cdn.example.com/large.pdf')
    expect(props.file).toBeUndefined()
    expect(props.type).toBe('pdf')
    expect(options.toolbar).toBe(false)
    expect(options.pdf).toMatchObject({
      toolbar: false,
      navigation: false,
      thumbnails: false,
      streaming: true,
      rangeChunkSize: 64 * 1024,
      withCredentials: false,
    })
  })

  it.each([true, false])('shows loading until the PDF viewer is ready (cover: %s)', coverOnly => {
    render(
      <FlyfishOfficePreview
        url="https://cdn.example.com/large.pdf"
        filename="large.pdf"
        restricted
        coverOnly={coverOnly}
      />
    )

    expect(screen.getByTestId('pdf-preview-loading')).toBeInTheDocument()
    const onStateChange = mockFileViewer.mock.calls.at(-1)![0].onStateChange as (
      state: Record<string, unknown>
    ) => void
    act(() => onStateChange({ loading: false, ready: true, error: null }))
    expect(screen.queryByTestId('pdf-preview-loading')).not.toBeInTheDocument()
  })

  it('keeps the PDF state callback stable without retaining an outdated error callback', () => {
    const firstError = jest.fn()
    const nextError = jest.fn()
    const { rerender } = render(
      <FlyfishOfficePreview
        url="https://cdn.example.com/large.pdf"
        filename="large.pdf"
        onError={firstError}
      />
    )
    const firstCallback = mockFileViewer.mock.calls.at(-1)![0].onStateChange

    rerender(
      <FlyfishOfficePreview
        url="https://cdn.example.com/large.pdf"
        filename="large.pdf"
        onError={nextError}
      />
    )
    const nextCallback = mockFileViewer.mock.calls.at(-1)![0].onStateChange as (
      state: Record<string, unknown>
    ) => void
    expect(nextCallback).toBe(firstCallback)
    const error = new Error('Preview unavailable')
    act(() => nextCallback({ loading: false, ready: false, error }))
    expect(nextError).toHaveBeenCalledWith(error)
    expect(firstError).not.toHaveBeenCalled()
    expect(screen.queryByTestId('pdf-preview-loading')).not.toBeInTheDocument()
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

  it('keeps spreadsheet DOM overlays in the scoped style surface', () => {
    render(
      <FlyfishOfficePreview
        blob={new Blob(['spreadsheet'], { type: 'application/octet-stream' })}
        filename="report.xlsx"
      />
    )

    const props = mockFileViewer.mock.calls[0][0]
    expect(props.className).not.toContain('overflow-auto')
    expect((props.options as { styleIsolation: string }).styleIsolation).toBe('scoped')
  })
})
