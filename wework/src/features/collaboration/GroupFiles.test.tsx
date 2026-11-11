import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CollaborationFilesView,
  createCollaborationTranslator,
  type CollaborationFilesApi,
  type CollaborationProjectFile,
} from '@wegent/collaboration'

function setup(failure?: Error) {
  const files: CollaborationProjectFile[] = []
  const entry = (path: string, kind: 'file' | 'folder'): CollaborationProjectFile => ({
    id: path,
    cloud_project_id: 'group',
    path,
    name: path,
    kind,
    content_type: null,
    size_bytes: 0,
    description: '',
    version: 1,
    created_at: '2026-11-11T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
  })
  const createFolder = vi.fn(async (_id: string | number, path: string) => {
    if (failure) throw failure
    const file = entry(path, 'folder')
    files.push(file)
    return file
  })
  const uploadFile = vi.fn(async (_id: string | number, _file: File, path: string) => {
    const file = entry(path, 'file')
    files.push(file)
    return file
  })
  const api = {
    listFiles: vi.fn(async () => [...files]),
    listDeliveryFiles: vi.fn(async () => []),
    createFolder,
    uploadFile,
  } as unknown as CollaborationFilesApi
  const view = render(
    <CollaborationFilesView
      api={api}
      project={{ id: 'group', project_store: 'local' }}
      PreviewComponent={() => null}
      saveDownload={vi.fn()}
      t={createCollaborationTranslator('zh-CN')}
    />
  )
  return { ...view, createFolder, uploadFile }
}

describe('group files creation feedback', () => {
  it('shows a newly created root folder in the shared directory immediately', async () => {
    const { createFolder } = setup()
    fireEvent.click(screen.getByTestId('cloud-folder-add'))
    fireEvent.change(screen.getByTestId('cloud-folder-name'), { target: { value: '交付资料' } })
    fireEvent.click(screen.getByTestId('cloud-folder-create-confirm'))
    expect(
      await screen.findByTestId('cloud-file-browser-entry-shared-folder:交付资料')
    ).toBeVisible()
    expect(createFolder).toHaveBeenCalledWith('group', '交付资料')
    expect(screen.queryByTestId('cloud-file-browser-entry-root:shared')).not.toBeInTheDocument()
  })

  it('shows uploaded root files in the shared directory instead of only changing a hidden count', async () => {
    const { container, uploadFile } = setup()
    const file = new File(['Ready'], 'review.txt', { type: 'text/plain' })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith('group', file, 'review.txt'))
    expect(await screen.findByText('review.txt')).toBeVisible()
    expect(screen.queryByTestId('cloud-file-browser-entry-root:shared')).not.toBeInTheDocument()
  })

  it('keeps the folder draft and root location when creation is rejected', async () => {
    setup(new Error('Group was archived'))
    fireEvent.click(screen.getByTestId('cloud-folder-add'))
    fireEvent.change(screen.getByTestId('cloud-folder-name'), { target: { value: '交付资料' } })
    fireEvent.click(screen.getByTestId('cloud-folder-create-confirm'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Group was archived')
    expect(screen.getByTestId('cloud-folder-name')).toHaveValue('交付资料')
    expect(screen.getByTestId('cloud-file-browser-entry-root:shared')).toBeVisible()
  })
})
