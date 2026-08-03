// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import fileViewerPackage from '@file-viewer/react/package.json'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useWecodeTranslation } from '@wecode/i18n/useWecodeTranslation'

interface ProtectedPdfPreviewProps {
  file: Blob
  onError?: (error: Error) => void
}

interface PdfJsModule {
  GlobalWorkerOptions: {
    workerSrc: string
  }
  getDocument(options: Record<string, unknown>): {
    promise: Promise<{
      numPages: number
      getPage(pageNumber: number): Promise<{
        getViewport(options: { scale: number }): {
          width: number
          height: number
        }
        render(options: Record<string, unknown>): {
          promise: Promise<void>
        }
      }>
    }>
    destroy(): Promise<void>
  }
}

const ASSET_BASE = `/file-viewer/${fileViewerPackage.version}-protected-docs-v1/vendor/pdf`

export function ProtectedPdfPreview({ file, onError }: ProtectedPdfPreviewProps) {
  const { t } = useWecodeTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [renderError, setRenderError] = useState(false)

  useEffect(() => {
    let disposed = false
    let loadingTask: { destroy: () => Promise<void> } | null = null
    const container = containerRef.current
    if (!container) return

    container.replaceChildren()
    setLoading(true)
    setRenderError(false)

    const render = async () => {
      try {
        const pdfjs = (await import(
          /* webpackIgnore: true */ `${ASSET_BASE}/pdf.mjs`
        )) as PdfJsModule
        pdfjs.GlobalWorkerOptions.workerSrc = `${ASSET_BASE}/pdf.worker.mjs`
        const task = pdfjs.getDocument({
          data: new Uint8Array(await file.arrayBuffer()),
          cMapUrl: `${ASSET_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${ASSET_BASE}/standard_fonts/`,
          wasmUrl: `${ASSET_BASE}/wasm/`,
        })
        loadingTask = task
        const pdf = await task.promise

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (disposed) return
          const page = await pdf.getPage(pageNumber)
          const viewport = page.getViewport({ scale: 1.5 })
          const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width * ratio)
          canvas.height = Math.floor(viewport.height * ratio)
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.style.maxWidth = '100%'
          canvas.className = 'block bg-white shadow'
          canvas.dataset.pageNumber = String(pageNumber)
          const context = canvas.getContext('2d')
          if (!context) throw new Error('PDF_CANVAS_UNAVAILABLE')
          container.appendChild(canvas)
          await page.render({
            canvas,
            canvasContext: context,
            viewport,
            transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          }).promise
        }
        if (!disposed) setLoading(false)
      } catch (error) {
        if (disposed) return
        setLoading(false)
        setRenderError(true)
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        console.error('Protected PDF rendering failed', normalizedError)
        onError?.(normalizedError)
      }
    }

    void render()
    return () => {
      disposed = true
      container.replaceChildren()
      void loadingTask?.destroy()
    }
  }, [file, onError])

  return (
    <div className="relative h-full overflow-auto bg-surface">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}
      {renderError && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center gap-2 p-6 text-sm text-red-600"
          data-testid="protected-pdf-render-failed"
        >
          <AlertCircle className="h-5 w-5" />
          {t('documentProtection.pdfRenderFailed')}
        </div>
      )}
      <div
        ref={containerRef}
        className="flex min-h-full flex-col items-center gap-4 p-4"
        data-testid="protected-pdf-preview"
      />
    </div>
  )
}
