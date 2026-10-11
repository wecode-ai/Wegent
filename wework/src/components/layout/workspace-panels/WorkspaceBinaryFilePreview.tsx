import FileViewer from '@file-viewer/react'
import engineeringRenderers from '@file-viewer/preset-engineering'
import officeRenderers from '@file-viewer/preset-office'
import liteRenderers from '@file-viewer/preset-lite'
import {
  memo,
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ProfilerOnRenderCallback,
} from 'react'
import { DiagramImageActions } from '@/components/chat/DiagramImageActions'
import { getRuntimeConfig } from '@/config/runtime'
import {
  logFilePreviewDiagnostic,
  scheduleFilePreviewMainThreadProbe,
} from '@/lib/file-preview-diagnostics'
import { WorkspaceXMindPreview } from './WorkspaceXMindPreview'

export interface WorkspaceBinaryFile {
  path: string
  name: string
  size: number
  file: File
  traceId?: string
}

const FILE_VIEWER_TYPE_BY_MIME: Record<string, string> = {
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'text/csv': 'csv',
}

const DIAGRAM_FILE_VIEWER_TYPE_BY_EXTENSION: Record<string, string> = {
  mermaid: 'mermaid',
  mmd: 'mermaid',
  plantuml: 'plantuml',
  puml: 'plantuml',
}

function workspaceFileViewerType(name: string, mimeType: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return (
    ({ csv: 'csv', tsv: 'csv', xlsm: 'xlsx' } as Record<string, string>)[extension] ??
    DIAGRAM_FILE_VIEWER_TYPE_BY_EXTENSION[extension] ??
    FILE_VIEWER_TYPE_BY_MIME[mimeType.split(';', 1)[0].trim().toLowerCase()]
  )
}

export const WorkspaceBinaryFilePreview = memo(function WorkspaceBinaryFilePreview({
  file,
  themeType,
}: {
  file: WorkspaceBinaryFile
  themeType: 'light' | 'dark'
}) {
  const containerRef = useRef<HTMLElement>(null)
  const viewerType = workspaceFileViewerType(file.name, file.file.type)
  const isDiagram = viewerType === 'mermaid' || viewerType === 'plantuml'
  const diagramFilename = `${file.name.replace(/\.[^.]+$/, '')}.png`
  const viewerOptions = useMemo(
    () => ({
      preset: [officeRenderers, liteRenderers, engineeringRenderers],
      drawing: { plantumlServerUrl: getRuntimeConfig().plantumlServerUrl },
      spreadsheet: { worker: false },
      theme: themeType,
    }),
    [themeType]
  )

  useLayoutEffect(() => {
    const traceId = file.traceId
    if (!traceId) return
    logFilePreviewDiagnostic(traceId, 'binary_preview_committed', {
      fileSize: file.size,
      viewerType: viewerType ?? null,
    })
    scheduleFilePreviewMainThreadProbe(traceId, 'binary_preview_committed')
    return () => {
      logFilePreviewDiagnostic(traceId, 'binary_preview_unmounted')
    }
  }, [file.size, file.traceId, viewerType])

  const handleFileViewerRender = useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (!file.traceId) return
      logFilePreviewDiagnostic(file.traceId, 'file_viewer_react_commit', {
        phase,
        actualDurationMs: Math.round(actualDuration * 10) / 10,
        baseDurationMs: Math.round(baseDuration * 10) / 10,
        startTimeMs: Math.round(startTime * 10) / 10,
        commitTimeMs: Math.round(commitTime * 10) / 10,
        viewerType: viewerType ?? null,
      })
    },
    [file.traceId, viewerType]
  )

  if (/\.(mp4|ogv|webm)$/i.test(file.name)) return <WorkspaceVideoPreview file={file.file} />

  if (/\.xmind$/i.test(file.name)) {
    return (
      <WorkspaceXMindPreview key={`${file.path}:${file.size}`} file={file.file} name={file.name} />
    )
  }

  return (
    <section
      data-testid="workspace-binary-file-preview"
      ref={containerRef}
      className="wework-diagram-preview relative min-w-0 flex-1 overflow-hidden bg-background"
    >
      <Profiler id="workspace-file-viewer" onRender={handleFileViewerRender}>
        <FileViewer
          key={`${file.path}:${file.size}`}
          file={file.file}
          filename={file.name}
          type={viewerType}
          size={file.size}
          data-viewer-theme={themeType}
          className="wework-workspace-file-viewer h-full w-full"
          options={viewerOptions}
        />
      </Profiler>
      {isDiagram ? (
        <DiagramImageActions
          containerRef={containerRef}
          filename={diagramFilename}
          theme={themeType}
        />
      ) : null}
    </section>
  )
})

function WorkspaceVideoPreview({ file }: { file: File }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const value = URL.createObjectURL(file)
    video.src = value
    return () => {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(value)
    }
  }, [file])
  return (
    <video
      data-testid="workspace-video-preview"
      ref={videoRef}
      controls
      className="h-full min-h-0 w-full flex-1 bg-background"
    />
  )
}
