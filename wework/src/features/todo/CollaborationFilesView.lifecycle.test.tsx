import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  CollaborationFilesView,
  type CollaborationFilesApi,
  type CollaborationFilePreviewProps,
  type CollaborationProjectFile,
  type CollaborationDeliveryFile,
} from '../../../../packages/collaboration/src/files'

const file: CollaborationProjectFile = {
  id: 'file-1',
  cloud_project_id: 'project-1',
  path: 'notes.txt',
  name: 'notes.txt',
  kind: 'file',
  content_type: 'text/plain',
  size_bytes: 5,
  description: '',
  version: 1,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:00:00Z',
}
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { resolve, reject, promise }
}
function createApi() {
  return {
    listFiles: vi.fn(async () => [file]),
    listDeliveryFiles: vi.fn(async (): Promise<CollaborationDeliveryFile[]> => []),
    listTaskAttachments: vi.fn(async () => []),
    createFolder: vi.fn(async () => file),
    uploadFile: vi.fn(async () => file),
    moveFile: vi.fn(async () => file),
    deleteFile: vi.fn(async () => {}),
    previewFile: vi.fn(async () => new Blob(['data'])),
    downloadFile: vi.fn(async () => new Blob(['data'])),
    previewDeliveryFile: vi.fn(async () => new Blob(['data'])),
    downloadDeliveryFile: vi.fn(async () => new Blob(['data'])),
  } satisfies CollaborationFilesApi
}
function Preview({ file, binaryFile, loading }: CollaborationFilePreviewProps) {
  return (
    <span data-testid="file-preview">{loading ? 'loading' : (file?.name ?? binaryFile?.name)}</span>
  )
}
const props = {
  project: { id: 'project-1', project_store: 'backend' as const },
  PreviewComponent: Preview,
  saveDownload: vi.fn(async () => {}),
}
function openShared() {
  fireEvent.click(screen.getByRole('button', { name: 'todo.shared_files' }))
}

test('shows shared files before other reads settle and isolates optional attachment failure', async () => {
  const api = createApi()
  const delivery = pending<CollaborationDeliveryFile[]>()
  api.listDeliveryFiles.mockReturnValue(delivery.promise)
  api.listTaskAttachments.mockRejectedValueOnce(new Error('Optional attachments unavailable'))
  render(<CollaborationFilesView {...props} api={api} />)
  openShared()
  expect(await screen.findByTestId('cloud-file-preview-file-1')).toHaveTextContent('notes.txt')
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => delivery.reject(new Error('Delivery files unavailable')))
  expect(screen.getByRole('alert')).toHaveTextContent('Delivery files unavailable')
  expect(screen.getByTestId('cloud-file-preview-file-1')).toBeInTheDocument()
})

test('resets preview and navigation for a new project and ignores old preview and list completions', async () => {
  const oldApi = createApi()
  const preview = pending<Blob>()
  const delivery = pending<CollaborationDeliveryFile[]>()
  oldApi.previewFile.mockReturnValue(preview.promise)
  oldApi.listDeliveryFiles.mockReturnValue(delivery.promise)
  const nextApi = createApi()
  nextApi.listFiles.mockResolvedValue([{ ...file, id: 'file-2', name: 'new.txt', path: 'new.txt' }])
  const { rerender } = render(<CollaborationFilesView {...props} api={oldApi} />)
  openShared()
  fireEvent.click(await screen.findByTestId('cloud-file-preview-file-1'))
  expect(screen.getByTestId('cloud-file-preview-sidebar')).toBeInTheDocument()
  rerender(
    <CollaborationFilesView
      {...props}
      project={{ ...props.project, id: 'project-2' }}
      api={nextApi}
    />
  )
  expect(screen.queryByTestId('cloud-file-preview-sidebar')).toBeNull()
  openShared()
  await screen.findByTestId('cloud-file-preview-file-2')
  await act(async () => {
    preview.resolve(new Blob(['old']))
    delivery.reject(new Error('Old project failed'))
  })
  expect(screen.queryByTestId('cloud-file-preview-sidebar')).toBeNull()
  expect(screen.queryByTestId('cloud-file-preview-file-1')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(nextApi.listFiles).toHaveBeenCalledExactlyOnceWith('project-2')
})

test('resets drafts for a different API even when the project id stays the same', async () => {
  const oldApi = createApi()
  const nextApi = createApi()
  const next = pending<CollaborationProjectFile[]>()
  nextApi.listFiles.mockReturnValue(next.promise)
  const { rerender } = render(<CollaborationFilesView {...props} api={oldApi} />)
  openShared()
  await screen.findByTestId('cloud-file-preview-file-1')
  fireEvent.click(screen.getByTestId('cloud-folder-add'))
  fireEvent.change(screen.getByTestId('cloud-folder-name'), { target: { value: 'Old draft' } })
  rerender(<CollaborationFilesView {...props} api={nextApi} />)
  expect(screen.queryByTestId('cloud-folder-name')).toBeNull()
  expect(screen.queryByTestId('cloud-file-preview-file-1')).toBeNull()
  expect(nextApi.listFiles).toHaveBeenCalledExactlyOnceWith('project-1')
  await act(async () => next.resolve([]))
})

test('does not restore a deleted file when an older refresh finishes', async () => {
  const api = createApi()
  const refresh = pending<CollaborationProjectFile[]>()
  api.listFiles.mockResolvedValueOnce([file]).mockReturnValueOnce(refresh.promise)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  try {
    render(<CollaborationFilesView {...props} api={api} />)
    openShared()
    await screen.findByTestId('cloud-file-preview-file-1')
    fireEvent.click(screen.getByTestId('cloud-folder-add'))
    fireEvent.change(screen.getByTestId('cloud-folder-name'), { target: { value: 'New folder' } })
    fireEvent.click(screen.getByTestId('cloud-folder-create-confirm'))
    await waitFor(() => expect(api.listFiles).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByTestId('cloud-file-delete-file-1'))
    await waitFor(() => expect(screen.queryByTestId('cloud-file-preview-file-1')).toBeNull())
    await act(async () => refresh.resolve([file]))
    expect(screen.queryByTestId('cloud-file-preview-file-1')).toBeNull()
    expect(api.deleteFile).toHaveBeenCalledExactlyOnceWith('file-1', false)
  } finally {
    confirm.mockRestore()
  }
})

test('formats a load error with the current translation without refetching the catalog', async () => {
  const api = createApi()
  api.listFiles.mockRejectedValueOnce('Unavailable')
  const { rerender } = render(
    <CollaborationFilesView {...props} api={api} t={(key, fallback) => 'zh:' + (fallback ?? key)} />
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('zh:加载文件失败')
  rerender(
    <CollaborationFilesView {...props} api={api} t={(key, fallback) => 'en:' + (fallback ?? key)} />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('en:加载文件失败')
  expect(api.listFiles).toHaveBeenCalledOnce()
})

test('isolates projects in different stores even when their API and id match', async () => {
  const api = createApi()
  api.listFiles
    .mockResolvedValueOnce([file])
    .mockResolvedValueOnce([{ ...file, id: 'local-file', name: 'local.txt', path: 'local.txt' }])
  const { rerender } = render(<CollaborationFilesView {...props} api={api} />)
  openShared()
  await screen.findByTestId('cloud-file-preview-file-1')
  rerender(
    <CollaborationFilesView
      {...props}
      project={{ ...props.project, project_store: 'local' }}
      api={api}
    />
  )
  openShared()
  expect(await screen.findByTestId('cloud-file-preview-local-file')).toHaveTextContent('local.txt')
  expect(screen.queryByTestId('cloud-file-preview-file-1')).toBeNull()
  expect(api.listFiles).toHaveBeenCalledTimes(2)
})
