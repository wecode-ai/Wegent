// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import FileViewer, { type ViewerOptions, type ViewerState } from '@file-viewer/react'
import fileViewerPackage from '@file-viewer/react/package.json'
import officePreset from '@file-viewer/preset-office'
import { useMemo } from 'react'

const FILE_VIEWER_ASSET_BASE = `/file-viewer/${fileViewerPackage.version}-office-v2`

const OFFICE_VIEWER_OPTIONS: ViewerOptions = {
  preset: officePreset,
  rendererMode: 'replace',
  styleIsolation: 'shadow',
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

const PRESENTATION_VIEWER_OPTIONS: ViewerOptions = {
  ...OFFICE_VIEWER_OPTIONS,
  styleIsolation: 'scoped',
}

interface FlyfishOfficePreviewProps {
  blob: Blob
  filename: string
  onError?: (error: Error) => void
}

export function FlyfishOfficePreview({ blob, filename, onError }: FlyfishOfficePreviewProps) {
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
  const isPresentation = extension === 'ppt' || extension === 'pptx'

  const handleStateChange = (state: ViewerState) => {
    if (!state.error || !onError) return
    onError(state.error instanceof Error ? state.error : new Error(String(state.error)))
  }

  return (
    <FileViewer
      key={`${file.name}:${file.size}:${file.lastModified}`}
      file={file}
      filename={file.name}
      type={extension}
      size={file.size}
      className={`h-full w-full${isPresentation ? ' overflow-auto' : ''}`}
      options={isPresentation ? PRESENTATION_VIEWER_OPTIONS : OFFICE_VIEWER_OPTIONS}
      onStateChange={handleStateChange}
      data-testid="flyfish-office-file-viewer"
    />
  )
}
