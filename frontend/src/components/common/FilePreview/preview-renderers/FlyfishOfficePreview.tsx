// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import FileViewer, { type ViewerOptions, type ViewerState } from '@file-viewer/react'
import fileViewerPackage from '@file-viewer/react/package.json'
import officePreset from '@file-viewer/preset-office'
import { useCallback, useMemo } from 'react'

const FILE_VIEWER_ASSET_BASE = `/file-viewer/${fileViewerPackage.version}-protected-docs-v1`

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
  blob: Blob
  filename: string
  onError?: (error: Error) => void
  protectedMode?: boolean
}

export function FlyfishOfficePreview({
  blob,
  filename,
  onError,
  protectedMode = false,
}: FlyfishOfficePreviewProps) {
  const file = useMemo(
    () =>
      blob instanceof File
        ? blob
        : new File([blob], filename, {
            type: blob.type || 'application/octet-stream',
          }),
    [blob, filename]
  )
  const extension = filename.split('.').pop()?.toLowerCase()
  const isPresentation = extension === 'pptx'
  // Keep options and callback identities stable: @file-viewer's React wrapper
  // reloads the document whenever any of these references changes, which drops
  // pagination and scroll state. Unmemoized values made every parent
  // re-render (document-list polling, watermark or protection state updates)
  // reset the viewer back to the first page while the user was reading.
  const viewerOptions = useMemo<ViewerOptions>(
    () =>
      protectedMode
        ? {
            ...OFFICE_VIEWER_OPTIONS,
            toolbar: {
              ...(typeof OFFICE_VIEWER_OPTIONS.toolbar === 'object'
                ? OFFICE_VIEWER_OPTIONS.toolbar
                : {}),
              download: false,
              exportHtml: false,
              print: false,
              permissions: {
                download: false,
                print: false,
                'export-html': false,
              },
            },
          }
        : OFFICE_VIEWER_OPTIONS,
    [protectedMode]
  )

  const handleStateChange = useCallback(
    (state: ViewerState) => {
      if (!state.error || !onError) return
      onError(state.error instanceof Error ? state.error : new Error(String(state.error)))
    },
    [onError]
  )

  return (
    <FileViewer
      key={`${file.name}:${file.size}:${file.lastModified}`}
      file={file}
      filename={file.name}
      type={extension}
      size={file.size}
      className={`h-full w-full${isPresentation ? ' overflow-auto' : ''}`}
      options={viewerOptions}
      onStateChange={handleStateChange}
      data-testid="flyfish-office-file-viewer"
    />
  )
}
