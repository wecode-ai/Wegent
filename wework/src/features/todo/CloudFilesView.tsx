import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Download,
  Eye,
  File,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react'
import type { CloudProject, CloudProjectFile, ProjectDeliveryFile } from '@/api/deliveries'
import { Tooltip } from '@/components/ui/tooltip'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import { CloudFilePreviewDialog } from './CloudFilePreviewDialog'
import {
  cloudFileBrowserBreadcrumbs,
  cloudFileBrowserEntries,
  type CloudFileBrowserLocation,
} from './cloudFileBrowser'
import { readFileFromAccessUrl, saveBlobToDownloads } from './cloudFileTransfer'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

interface FilePreviewTarget {
  id: string
  filename: string
  contentType: string | null
  loadFile: () => Promise<Blob>
  download: () => Promise<void>
}

function downloadName(path: string): string {
  return path.split(/[\\/]/).pop() || 'download'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function CloudFilesView({ api, project }: { api: DeliveryApi; project: CloudProject }) {
  const { t } = useTranslation('common')
  const [files, setFiles] = useState<CloudProjectFile[]>([])
  const [deliveryFiles, setDeliveryFiles] = useState<ProjectDeliveryFile[]>([])
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [uploadingCount, setUploadingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [editingPath, setEditingPath] = useState('')
  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(null)
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null)
  const projectLocationKey = String(project.id)
  const [locationState, setLocationState] = useState<{
    projectKey: string
    location: CloudFileBrowserLocation
  }>({ projectKey: projectLocationKey, location: { scope: 'root' } })
  const location = useMemo<CloudFileBrowserLocation>(
    () =>
      locationState.projectKey === projectLocationKey ? locationState.location : { scope: 'root' },
    [locationState, projectLocationKey]
  )
  const navigateTo = useCallback(
    (nextLocation: CloudFileBrowserLocation) =>
      setLocationState({ projectKey: projectLocationKey, location: nextLocation }),
    [projectLocationKey]
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const refresh = useCallback(() => {
    void Promise.all([api.listCloudFiles(project.id), api.listProjectDeliveryFiles(project.id)])
      .then(([shared, delivered]) => {
        setFiles(shared.items)
        setDeliveryFiles(delivered.items)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : '加载文件失败'))
  }, [api, project.id])
  useEffect(refresh, [refresh])

  const entries = useMemo(
    () => cloudFileBrowserEntries(location, files, deliveryFiles),
    [deliveryFiles, files, location]
  )
  const breadcrumbs = useMemo(
    () => cloudFileBrowserBreadcrumbs(location, deliveryFiles),
    [deliveryFiles, location]
  )

  async function uploadFiles(selected: File[]) {
    if (selected.length === 0) return
    setUploadingCount(selected.length)
    setError(null)
    try {
      const parentPath = location.scope === 'shared' ? location.path.join('/') : ''
      await Promise.all(
        selected.map(file =>
          api.uploadCloudFile(
            project.id,
            file,
            parentPath ? `${parentPath}/${file.name}` : file.name
          )
        )
      )
      refresh()
      track('feature_action_completed', { action: 'upload', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试')
      track('operation_failed', { operation: 'project_space_file_action' })
    } finally {
      setUploadingCount(0)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function createFolder() {
    const relativePath = folderName.trim().replace(/^\/+|\/+$/g, '')
    if (!relativePath || location.scope !== 'shared') return
    const path = [...location.path, relativePath].filter(Boolean).join('/')
    setError(null)
    try {
      await api.createCloudFolder(project.id, path)
      setFolderName('')
      setCreatingFolder(false)
      refresh()
      track('feature_action_completed', { action: 'create', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建文件夹失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  async function readCloudFile(entry: CloudProjectFile): Promise<Blob> {
    const access = await api.accessCloudFile(entry.id)
    return readFileFromAccessUrl(access.url)
  }

  async function readDeliveryFile(entry: ProjectDeliveryFile): Promise<Blob> {
    const access = await api.accessDeliveryFile(entry.asset_id)
    return readFileFromAccessUrl(access.url)
  }

  async function downloadFile(
    id: string,
    filename: string,
    loadFile: () => Promise<Blob>
  ): Promise<void> {
    setDownloadingFileId(id)
    setError(null)
    try {
      await saveBlobToDownloads(await loadFile(), filename)
      track('feature_action_completed', { action: 'download', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '下载文件失败')
      track('operation_failed', { operation: 'project_space_file_action' })
      throw cause
    } finally {
      setDownloadingFileId(null)
    }
  }

  function previewCloudFile(entry: CloudProjectFile) {
    if (entry.kind !== 'file') return
    const loadFile = () => readCloudFile(entry)
    setPreviewTarget({
      id: entry.id,
      filename: entry.path,
      contentType: entry.content_type,
      loadFile,
      download: () => downloadFile(entry.id, downloadName(entry.path), loadFile),
    })
    track('feature_action_completed', { action: 'preview', domain: 'project_space_file' })
  }

  function previewDeliveryFile(entry: ProjectDeliveryFile) {
    const loadFile = () => readDeliveryFile(entry)
    setPreviewTarget({
      id: entry.asset_id,
      filename: entry.relative_path,
      contentType: entry.content_type,
      loadFile,
      download: () => downloadFile(entry.asset_id, entry.display_name, loadFile),
    })
    track('feature_action_completed', { action: 'preview', domain: 'project_space_file' })
  }

  async function deleteFile(entry: CloudProjectFile) {
    if (!window.confirm(`删除“${entry.path}”？此操作无法撤销。`)) return
    setError(null)
    try {
      await api.deleteCloudFile(entry.id, entry.kind === 'folder')
      setFiles(current =>
        current.filter(file => file.id !== entry.id && !file.path.startsWith(`${entry.path}/`))
      )
      track('feature_action_completed', { action: 'delete', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  async function moveFile(entry: CloudProjectFile) {
    const path = editingPath.trim()
    if (!path || path === entry.path) {
      setEditingFileId(null)
      return
    }
    setError(null)
    try {
      await api.moveCloudFile(entry.id, path, entry.version)
      setEditingFileId(null)
      refresh()
      track('feature_action_completed', { action: 'move', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名或移动失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  return (
    <div data-testid="cloud-files-view" className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[1040px]">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-heading-md font-semibold">{t('todo.files_title', '文件')}</h2>
            <p className="mt-1 text-sm text-text-muted">
              {t('todo.files_description', '浏览共享文件，以及按 Issue 和任务整理的交付快照。')}
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => void uploadFiles([...(event.target.files ?? [])])}
          />
          {location.scope === 'shared' ? (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid="cloud-folder-add"
                onClick={() => setCreatingFolder(true)}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-hover"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                {t('todo.new_folder', '新建文件夹')}
              </button>
              <button
                type="button"
                data-testid="cloud-files-upload"
                onClick={() => inputRef.current?.click()}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadingCount > 0
                  ? t('todo.uploading_file_count', '正在上传 {{count}} 项…', {
                      count: uploadingCount,
                    })
                  : t('todo.upload_files', '上传文件')}
              </button>
            </div>
          ) : null}
        </div>

        {creatingFolder && location.scope === 'shared' ? (
          <div className="mt-4 flex items-center gap-2">
            <input
              autoFocus
              data-testid="cloud-folder-name"
              value={folderName}
              onChange={event => setFolderName(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && void createFolder()}
              placeholder={t('todo.folder_name_placeholder', '文件夹名称')}
              className="h-8 min-w-0 flex-1 rounded-md border border-border px-3 text-sm outline-none focus:border-focus"
            />
            <button
              type="button"
              data-testid="cloud-folder-create-confirm"
              onClick={() => void createFolder()}
              className="h-8 rounded-md bg-text-primary px-3 text-sm text-background"
            >
              {t('common.create', '创建')}
            </button>
            <button
              type="button"
              onClick={() => setCreatingFolder(false)}
              className="h-8 rounded-md px-3 text-sm hover:bg-hover"
            >
              {t('common.cancel', '取消')}
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <nav
            data-testid="cloud-file-breadcrumbs"
            aria-label={t('todo.file_path', '文件路径')}
            className="flex h-11 items-center gap-0.5 border-b border-border px-3"
          >
            {breadcrumbs.map((breadcrumb, index) => (
              <span key={breadcrumb.key} className="flex min-w-0 items-center">
                {index > 0 ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setCreatingFolder(false)
                    navigateTo(breadcrumb.location)
                  }}
                  className="max-w-48 truncate rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  {breadcrumb.name}
                </button>
              </span>
            ))}
          </nav>

          <div className="grid h-9 grid-cols-[minmax(0,1fr)_150px_90px_132px] items-center bg-muted/30 px-4 text-xs text-text-muted">
            <span>{t('todo.file_name', '名称')}</span>
            <span>{t('todo.file_updated_at', '更新时间')}</span>
            <span>{t('todo.file_size', '大小')}</span>
            <span />
          </div>

          {entries.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-text-muted">
              <Folder className="h-6 w-6" />
              <span>{t('todo.folder_empty', '此文件夹为空')}</span>
            </div>
          ) : (
            entries.map(entry => {
              const sharedEntry =
                entry.kind === 'shared-file'
                  ? entry.file
                  : entry.kind === 'folder'
                    ? entry.sharedFolder
                    : undefined
              const deliveryEntry = entry.kind === 'delivery-file' ? entry.file : undefined
              const updatedAt =
                entry.kind === 'folder'
                  ? entry.updatedAt
                  : entry.kind === 'shared-file'
                    ? entry.file.updated_at
                    : entry.file.delivered_at
              const size =
                entry.kind === 'shared-file'
                  ? formatFileSize(entry.file.size_bytes)
                  : entry.kind === 'delivery-file'
                    ? formatFileSize(entry.file.size_bytes)
                    : '—'

              return (
                <div
                  key={entry.key}
                  data-testid={
                    entry.kind === 'delivery-file'
                      ? `delivery-file-${entry.file.asset_id}`
                      : `cloud-file-browser-entry-${entry.key}`
                  }
                  className="group grid min-h-12 grid-cols-[minmax(0,1fr)_150px_90px_132px] items-center border-t border-border px-4 text-xs transition-colors hover:bg-muted/50"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {entry.kind === 'folder' ? (
                      <Folder className="h-4 w-4 shrink-0 text-text-muted" />
                    ) : (
                      <File className="h-4 w-4 shrink-0 text-text-muted" />
                    )}
                    {sharedEntry && editingFileId === sharedEntry.id ? (
                      <input
                        autoFocus
                        data-testid={`cloud-file-path-${sharedEntry.id}`}
                        value={editingPath}
                        onChange={event => setEditingPath(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void moveFile(sharedEntry)
                          if (event.key === 'Escape') setEditingFileId(null)
                        }}
                        className="h-7 min-w-0 flex-1 rounded border border-focus bg-background px-2 outline-none"
                      />
                    ) : entry.kind === 'folder' ? (
                      <button
                        type="button"
                        aria-label={entry.name}
                        onClick={() => {
                          setCreatingFolder(false)
                          navigateTo(entry.location)
                        }}
                        className="flex min-w-0 flex-col items-start text-left"
                      >
                        <span className="max-w-full truncate text-sm font-medium text-text-primary">
                          {entry.name}
                        </span>
                        <span className="max-w-full truncate text-xs text-text-muted">
                          {entry.description}
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={
                          entry.kind === 'shared-file'
                            ? `cloud-file-preview-${entry.file.id}`
                            : `delivery-file-preview-${entry.file.asset_id}`
                        }
                        onClick={() =>
                          entry.kind === 'shared-file'
                            ? previewCloudFile(entry.file)
                            : previewDeliveryFile(entry.file)
                        }
                        className="min-w-0 truncate text-left text-sm font-medium text-text-primary hover:underline"
                      >
                        {entry.name}
                      </button>
                    )}
                  </div>
                  <span className="text-text-muted">{updatedAt?.slice(0, 10) ?? '—'}</span>
                  <span className="text-text-muted">{size}</span>
                  <span className="flex justify-end gap-1">
                    {sharedEntry ? (
                      <Tooltip
                        label={t('todo.rename_or_move_file', '重命名或移动 {{path}}', {
                          path: sharedEntry.path,
                        })}
                      >
                        <button
                          type="button"
                          data-testid={`cloud-file-rename-${sharedEntry.id}`}
                          onClick={() => {
                            setEditingFileId(sharedEntry.id)
                            setEditingPath(sharedEntry.path)
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                          aria-label={t('todo.rename_or_move_file', '重命名或移动 {{path}}', {
                            path: sharedEntry.path,
                          })}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    ) : null}
                    {sharedEntry?.kind === 'file' ? (
                      <>
                        <Tooltip
                          label={t('todo.preview_file_path', '预览 {{path}}', {
                            path: sharedEntry.path,
                          })}
                        >
                          <button
                            type="button"
                            data-testid={`cloud-file-open-${sharedEntry.id}`}
                            onClick={() => previewCloudFile(sharedEntry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('todo.preview_file_path', '预览 {{path}}', {
                              path: sharedEntry.path,
                            })}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip
                          label={t('todo.download_file_path', '下载 {{path}}', {
                            path: sharedEntry.path,
                          })}
                        >
                          <button
                            type="button"
                            data-testid={`cloud-file-download-${sharedEntry.id}`}
                            disabled={downloadingFileId === sharedEntry.id}
                            onClick={() =>
                              void downloadFile(
                                sharedEntry.id,
                                downloadName(sharedEntry.path),
                                () => readCloudFile(sharedEntry)
                              ).catch(() => undefined)
                            }
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
                            aria-label={t('todo.download_file_path', '下载 {{path}}', {
                              path: sharedEntry.path,
                            })}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </>
                    ) : null}
                    {deliveryEntry ? (
                      <>
                        <Tooltip
                          label={t('todo.preview_delivery_file', '预览交付文件 {{path}}', {
                            path: deliveryEntry.relative_path,
                          })}
                        >
                          <button
                            type="button"
                            data-testid={`delivery-file-open-${deliveryEntry.asset_id}`}
                            onClick={() => previewDeliveryFile(deliveryEntry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('todo.preview_delivery_file', '预览交付文件 {{path}}', {
                              path: deliveryEntry.relative_path,
                            })}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip
                          label={t('todo.download_delivery_file', '下载交付文件 {{path}}', {
                            path: deliveryEntry.relative_path,
                          })}
                          align="end"
                        >
                          <button
                            type="button"
                            data-testid={`delivery-file-download-${deliveryEntry.asset_id}`}
                            disabled={downloadingFileId === deliveryEntry.asset_id}
                            onClick={() =>
                              void downloadFile(
                                deliveryEntry.asset_id,
                                deliveryEntry.display_name,
                                () => readDeliveryFile(deliveryEntry)
                              ).catch(() => undefined)
                            }
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
                            aria-label={t('todo.download_delivery_file', '下载交付文件 {{path}}', {
                              path: deliveryEntry.relative_path,
                            })}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </>
                    ) : null}
                    {sharedEntry ? (
                      <Tooltip
                        label={t('todo.delete_file_path', '删除 {{path}}', {
                          path: sharedEntry.path,
                        })}
                        align="end"
                      >
                        <button
                          type="button"
                          data-testid={`cloud-file-delete-${sharedEntry.id}`}
                          onClick={() => void deleteFile(sharedEntry)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-destructive"
                          aria-label={t('todo.delete_file_path', '删除 {{path}}', {
                            path: sharedEntry.path,
                          })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    ) : null}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
      {previewTarget ? (
        <CloudFilePreviewDialog
          key={previewTarget.id}
          filename={previewTarget.filename}
          contentType={previewTarget.contentType}
          loadFile={previewTarget.loadFile}
          onDownload={previewTarget.download}
          onClose={() => setPreviewTarget(null)}
        />
      ) : null}
    </div>
  )
}
