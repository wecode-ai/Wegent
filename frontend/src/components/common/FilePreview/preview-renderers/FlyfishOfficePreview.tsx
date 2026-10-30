// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import FileViewer, { type ViewerOptions, type ViewerState } from '@file-viewer/react'
import fileViewerPackage from '@file-viewer/react/package.json'
import officePreset from '@file-viewer/preset-office'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'

const FILE_VIEWER_ASSET_BASE = `/file-viewer/${fileViewerPackage.version}-office-pdf-v3`

const OFFICE_VIEWER_OPTIONS: ViewerOptions = {
  preset: officePreset,
  rendererMode: 'replace',
  styleIsolation: 'scoped',
  theme: 'light',
  toolbar: {
    download: false,
    exportHtml: false,
    theme: false,
    position: 'bottom-right',
  },
  pdf: {
    assetBaseUrl: `${FILE_VIEWER_ASSET_BASE}/`,
    workerUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/pdf/pdf.worker.mjs`,
    cMapUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/pdf/cmaps/`,
    wasmUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/pdf/wasm/`,
    standardFontDataUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/pdf/standard_fonts/`,
    cjkFontFallbackPath: `${FILE_VIEWER_ASSET_BASE}/vendor/pdf/fonts/`,
  },
  docx: {
    workerUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/docx/docx.worker.js`,
    workerJsZipUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/docx/jszip.min.js`,
    visualPagination: true,
  },
  spreadsheet: {
    worker: 'auto',
    workerUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/xlsx/sheet.worker.js`,
  },
  presentation: {
    workerUrl: `${FILE_VIEWER_ASSET_BASE}/vendor/pptx/pptx.worker.js`,
  },
}

interface FlyfishOfficePreviewProps {
  blob?: Blob
  url?: string
  filename: string
  onError?: (error: Error) => void
  restricted?: boolean
  coverOnly?: boolean
  validatedRemotePdf?: boolean
}

export function FlyfishOfficePreview({
  blob,
  url,
  filename,
  onError,
  restricted = false,
  coverOnly = false,
  validatedRemotePdf = false,
}: FlyfishOfficePreviewProps) {
  const { t } = useTranslation('common')
  const [pdfLoading, setPdfLoading] = useState(true)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const file = useMemo(
    () =>
      !blob
        ? undefined
        : blob instanceof File
          ? blob
          : new File([blob], filename, {
              type: blob.type || 'application/octet-stream',
            }),
    [blob, filename]
  )
  const extension = filename.split('.').pop()?.toLowerCase()
  const isPdf = extension === 'pdf'
  const isPresentation = extension === 'pptx'
  useEffect(() => {
    setPdfLoading(true)
  }, [file, url, filename])
  const options = useMemo<ViewerOptions>(
    () => ({
      ...OFFICE_VIEWER_OPTIONS,
      toolbar: coverOnly
        ? false
        : restricted
          ? {
              download: false,
              exportHtml: false,
              theme: false,
              position: 'bottom-right',
              print: false,
              permissions: {
                download: false,
                print: false,
                'export-html': false,
              },
            }
          : OFFICE_VIEWER_OPTIONS.toolbar,
      pdf: {
        ...OFFICE_VIEWER_OPTIONS.pdf,
        toolbar: !coverOnly,
        navigation: !coverOnly,
        thumbnails: !coverOnly,
        streaming: validatedRemotePdf,
        rangeChunkSize: 64 * 1024,
        withCredentials: false,
      },
    }),
    [coverOnly, restricted, validatedRemotePdf]
  )

  // The React viewer reloads its source when this callback changes. Keep it
  // stable across progress updates and parent renders, including cover loads.
  const handleStateChange = useCallback(
    (state: ViewerState) => {
      if (isPdf) setPdfLoading(!state.ready && !state.error)
      if (!state.error) return
      onErrorRef.current?.(
        state.error instanceof Error ? state.error : new Error(String(state.error))
      )
    },
    [isPdf]
  )

  const viewer = (
    <FileViewer
      key={file ? `${file.name}:${file.size}:${file.lastModified}` : url}
      url={url}
      file={file}
      filename={file?.name || filename}
      type={extension}
      size={file?.size}
      className={`h-full w-full${isPresentation ? ' overflow-auto' : ''}`}
      options={options}
      onStateChange={handleStateChange}
      data-testid="flyfish-office-file-viewer"
    />
  )

  if (!isPdf) return viewer

  return (
    <div className="relative h-full w-full" aria-busy={pdfLoading}>
      {viewer}
      {pdfLoading && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-surface/90"
          data-testid="pdf-preview-loading"
        >
          <Spinner text={t('loading')} />
        </div>
      )}
    </div>
  )
}
