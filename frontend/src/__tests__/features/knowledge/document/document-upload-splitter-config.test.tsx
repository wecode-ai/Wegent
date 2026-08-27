// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { uploadAttachment, deleteAttachment } from '@/apis/attachments'

import { DocumentUpload } from '@/features/knowledge/document/components/DocumentUpload'

const mockUseBatchAttachment = jest.fn()

jest.mock('@/apis/attachments', () => ({
  ...jest.requireActual('@/apis/attachments'),
  uploadAttachment: jest.fn(),
  deleteAttachment: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; max?: number; maxSize?: number }) => {
      if (key === 'document.upload.confirmUpload') {
        return `Confirm upload (${options?.count ?? 0})`
      }

      const translations: Record<string, string> = {
        'document.document.upload': 'Upload documents',
        'document.document.dropzone': 'Drop files here',
        'document.upload.uploadFile': 'Upload file',
        'document.upload.pasteText': 'Paste text',
        'document.upload.dropzoneHint': `Drop up to ${options?.max ?? 20} files`,
        'document.document.supportedTypes': `Supported types up to ${options?.maxSize ?? 15} MB`,
        'document.upload.fileList': `Files (${options?.count ?? 0})`,
        'document.upload.clearAll': 'Clear all',
        'document.advancedSettings.title': 'Advanced settings',
        'document.upload.summary': 'Upload summary',
        'document.upload.confirming': 'Confirming',
        'common:actions.cancel': 'Cancel',
      }

      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/hooks/useBatchAttachment', () => ({
  MAX_BATCH_FILES: 20,
  useBatchAttachment: () => mockUseBatchAttachment(),
}))

jest.mock('@/features/knowledge/document/components/SplitterSettingsSection', () => ({
  SplitterSettingsSection: () => <div data-testid="splitter-settings-section" />,
}))

jest.mock('@/components/ui/accordion', () => ({
  Accordion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AccordionTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AccordionContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('DocumentUpload splitter config defaults', () => {
  beforeEach(() => {
    mockUseBatchAttachment.mockReset()
  })

  it('submits flat + file_aware + title enhancement as the default config for new uploads', async () => {
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' })
    const onUploadComplete = jest.fn().mockResolvedValue([{ attachmentId: 101, documentId: 201 }])
    const applyDocumentCreationResults = jest.fn()

    mockUseBatchAttachment.mockReturnValue({
      state: {
        files: [
          {
            id: 'file-1',
            file,
            status: 'success',
            progress: 100,
            error: null,
            attachment: {
              id: 101,
              filename: 'notes.md',
              file_size: 5,
              mime_type: 'text/markdown',
              status: 'success',
              text_length: 5,
              error_message: null,
              error_code: null,
              subtask_id: null,
              file_extension: '.md',
              created_at: '2026-04-10T00:00:00Z',
            },
          },
        ],
        isUploading: false,
        summary: null,
      },
      addFiles: jest.fn(),
      removeFile: jest.fn(),
      clearFiles: jest.fn(),
      startUpload: jest.fn(),
      retryFile: jest.fn(),
      renameFile: jest.fn(),
      reset: jest.fn(),
      applyDocumentCreationResults,
    })

    render(
      <DocumentUpload
        knowledgeBaseId={42}
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={onUploadComplete}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Confirm upload (1)' }))

    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1))
    expect(applyDocumentCreationResults).toHaveBeenCalledWith([
      { attachmentId: 101, documentId: 201 },
    ])

    expect(onUploadComplete).toHaveBeenCalledWith(
      [
        {
          attachment: expect.objectContaining({
            id: 101,
            filename: 'notes.md',
          }),
          file,
        },
      ],
      {
        chunk_strategy: 'flat',
        format_enhancement: 'file_aware',
        flat_config: {
          chunk_size: 1024,
          chunk_overlap: 50,
          separator: '\n\n',
        },
        markdown_enhancement: {
          enabled: true,
        },
      },
      // Third arg: per-media-type multimodal prompt overrides. undefined for a
      // non-multimodal (.md) upload — the document inherits the KB default.
      undefined
    )
  })

  it('retries document creation without uploading the attachment again', async () => {
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' })
    const onUploadComplete = jest.fn().mockResolvedValue([{ attachmentId: 101, documentId: 201 }])
    const retryFile = jest.fn()

    mockUseBatchAttachment.mockReturnValue({
      state: {
        files: [
          {
            id: 'file-1',
            file,
            status: 'error',
            progress: 100,
            error: 'create failed',
            attachment: {
              id: 101,
              filename: 'notes.md',
              file_size: 5,
              mime_type: 'text/markdown',
              status: 'ready',
              file_extension: '.md',
              created_at: '2026-04-10T00:00:00Z',
            },
          },
        ],
        isUploading: false,
        summary: null,
      },
      addFiles: jest.fn(),
      removeFile: jest.fn(),
      clearFiles: jest.fn(),
      startUpload: jest.fn(),
      retryFile,
      renameFile: jest.fn(),
      reset: jest.fn(),
      applyDocumentCreationResults: jest.fn(),
    })

    render(
      <DocumentUpload
        knowledgeBaseId={42}
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={onUploadComplete}
      />
    )

    fireEvent.click(screen.getByTestId('document-creation-retry-file-1'))

    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledTimes(1))
    expect(onUploadComplete).toHaveBeenCalledWith(
      [
        {
          attachment: expect.objectContaining({ id: 101 }),
          file,
        },
      ],
      expect.any(Object),
      undefined
    )
    expect(retryFile).not.toHaveBeenCalled()
  })
})

describe('DocumentUpload source interactions', () => {
  const mockUpload = jest.mocked(uploadAttachment)
  const createDocuments = jest.fn()
  const onOpenChange = jest.fn()

  beforeEach(() => {
    mockUseBatchAttachment.mockImplementation(
      jest.requireActual('@/hooks/useBatchAttachment').useBatchAttachment
    )
    mockUpload.mockReset()
    let attachmentId = 100
    mockUpload.mockImplementation(async file => ({
      id: ++attachmentId,
      filename: file.name,
      file_size: file.size,
      mime_type: file.type,
      status: 'ready',
    }))
    createDocuments.mockReset()
    createDocuments.mockImplementation(async items =>
      items.map(({ attachment }: { attachment: { id: number } }) => ({
        attachmentId: attachment.id,
        documentId: attachment.id + 1000,
      }))
    )
    onOpenChange.mockReset()
  })

  function mount(onWebAdd = jest.fn().mockResolvedValue(undefined)) {
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <DocumentUpload
          knowledgeBaseId={42}
          open={open}
          onOpenChange={value => {
            onOpenChange(value)
            setOpen(value)
          }}
          onUploadComplete={createDocuments}
          onWebAdd={onWebAdd}
        />
      )
    }
    return render(<Harness />)
  }

  function selectSource(source: 'file' | 'text' | 'web') {
    fireEvent.click(screen.getByTestId(`document-source-${source}`))
  }

  async function addLocalFile() {
    fireEvent.change(screen.getByTestId('document-upload-file-input'), {
      target: { files: [new File(['file contents'], 'local.md', { type: 'text/markdown' })] },
    })
    await waitFor(() => expect(screen.getByTestId('document-upload-submit')).toBeEnabled())
  }

  it('adds text in one submission without submitting or clearing local file drafts', async () => {
    mount()
    await addLocalFile()
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-title'), { target: { value: 'Notes' } })
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Text contents' },
    })
    fireEvent.click(screen.getByTestId('document-text-submit'))

    await waitFor(() => expect(createDocuments).toHaveBeenCalledTimes(1))
    const submitted = createDocuments.mock.calls[0][0]
    expect(submitted).toHaveLength(1)
    expect(submitted[0].file.name).toBe('Notes.txt')
    await waitFor(() => expect(screen.getByTestId('document-text-content')).toHaveValue(''))
    expect(onOpenChange).not.toHaveBeenCalled()
    selectSource('file')
    expect(screen.getByText('local.md')).toBeVisible()
    fireEvent.click(screen.getByTestId('document-upload-submit'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(createDocuments.mock.calls[1][0][0].file.name).toBe('local.md')
  })

  it('retains failed text and reuses its uploaded attachment when retrying creation', async () => {
    createDocuments.mockResolvedValueOnce([{ attachmentId: 101, error: 'Creation unavailable' }])
    mount()
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Keep on failure' },
    })
    fireEvent.click(screen.getByTestId('document-text-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Creation unavailable')
    expect(screen.getByTestId('document-text-content')).toHaveValue('Keep on failure')
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('document-text-submit'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(createDocuments).toHaveBeenCalledTimes(2)
  })

  it('uploads edited text again instead of reusing the failed draft attachment', async () => {
    createDocuments.mockResolvedValueOnce([{ attachmentId: 101, error: 'Creation unavailable' }])
    mount()
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'First version' },
    })
    fireEvent.click(screen.getByTestId('document-text-submit'))
    await screen.findByRole('alert')
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Revised version' },
    })
    fireEvent.click(screen.getByTestId('document-text-submit'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(createDocuments.mock.calls[1][0][0].attachment.id).toBe(102)
  })

  it('blocks closing and duplicate submissions while adding a web page and preserves other drafts', async () => {
    let resolveWeb!: () => void
    const onWebAdd = jest.fn(
      () =>
        new Promise<void>(resolve => {
          resolveWeb = resolve
        })
    )
    mount(onWebAdd)
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Unsubmitted text' },
    })
    selectSource('web')
    fireEvent.change(screen.getByTestId('document-web-url'), {
      target: { value: 'javascript:alert(1)' },
    })
    expect(screen.getByTestId('document-web-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('document-web-url'), {
      target: { value: 'https://example.com/article' },
    })
    fireEvent.click(screen.getByTestId('document-web-submit'))
    fireEvent.click(screen.getByTestId('document-web-submit'))
    expect(screen.getByTestId('document-upload-close')).toBeDisabled()
    expect(screen.getByTestId('document-source-text')).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => resolveWeb())
    expect(onWebAdd).toHaveBeenCalledTimes(1)
    expect(onWebAdd).toHaveBeenCalledWith('https://example.com/article')
    expect(onOpenChange).not.toHaveBeenCalled()
    selectSource('text')
    expect(screen.getByTestId('document-text-content')).toHaveValue('Unsubmitted text')
  })

  it('confirms dismissal only when drafts exist and supports keeping or discarding them', async () => {
    mount()
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-content'), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByTestId('document-upload-cancel'))
    expect(screen.getByRole('alertdialog')).toBeVisible()
    fireEvent.click(screen.getByTestId('document-upload-keep'))
    expect(screen.getByTestId('document-text-content')).toHaveValue('Draft')
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    expect(await screen.findByRole('alertdialog')).toBeVisible()
    fireEvent.click(screen.getByTestId('document-upload-discard'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes an empty dialog without a discard confirmation', () => {
    mount()
    fireEvent.click(screen.getByTestId('document-upload-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('uploads a failed file only once when retry is clicked', async () => {
    mockUpload.mockRejectedValueOnce(new Error('Upload unavailable'))
    mount()
    fireEvent.change(screen.getByTestId('document-upload-file-input'), {
      target: { files: [new File(['file contents'], 'retry.md', { type: 'text/markdown' })] },
    })
    await screen.findByText('Upload unavailable')
    fireEvent.click(screen.getByTestId(/^document-upload-retry-/))
    await waitFor(() => expect(screen.getByTestId('document-upload-submit')).toBeEnabled())
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(createDocuments).not.toHaveBeenCalled()
  })

  it('retains other failed files when a single document creation retry succeeds', async () => {
    createDocuments.mockImplementationOnce(async items =>
      items.map(({ attachment }: { attachment: { id: number } }) => ({
        attachmentId: attachment.id,
        error: 'Cannot create document',
      }))
    )
    mount()
    fireEvent.change(screen.getByTestId('document-upload-file-input'), {
      target: {
        files: ['first.md', 'second.md'].map(
          name => new File(['contents'], name, { type: 'text/markdown' })
        ),
      },
    })
    await waitFor(() => expect(screen.getByTestId('document-upload-submit')).toBeEnabled())
    fireEvent.click(screen.getByTestId('document-upload-submit'))
    await waitFor(() => expect(screen.getAllByTestId(/^document-creation-retry-/)).toHaveLength(2))
    fireEvent.click(screen.getAllByTestId(/^document-creation-retry-/)[0])
    await waitFor(() => expect(screen.getAllByTestId(/^document-creation-retry-/)).toHaveLength(1))
    expect(screen.getByText('second.md')).toBeVisible()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId(/^document-creation-retry-/))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('keeps text when the attachment upload fails and does not create a document', async () => {
    mockUpload.mockRejectedValueOnce(new Error('Network unavailable'))
    mount()
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Important draft' },
    })
    fireEvent.click(screen.getByTestId('document-text-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
    expect(screen.getByTestId('document-text-content')).toHaveValue('Important draft')
    expect(createDocuments).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('retains web input and its localized error when fetching fails', async () => {
    mount(jest.fn().mockRejectedValue(new Error('FETCH_TIMEOUT')))
    selectSource('web')
    fireEvent.change(screen.getByTestId('document-web-url'), {
      target: { value: 'https://example.com/article' },
    })
    fireEvent.click(screen.getByTestId('document-web-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('document.upload.web.fetchTimeout')
    expect(screen.getByTestId('document-web-url')).toHaveValue('https://example.com/article')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not create a document from a failed text attachment', async () => {
    mockUpload.mockResolvedValueOnce({
      id: 201,
      filename: 'failed.txt',
      file_size: 10,
      mime_type: 'text/plain',
      status: 'failed',
      error_message: 'Unable to parse',
    })
    mount()
    selectSource('text')
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Retain this text' },
    })
    fireEvent.click(screen.getByTestId('document-text-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to parse')
    expect(screen.getByTestId('document-text-content')).toHaveValue('Retain this text')
    expect(createDocuments).not.toHaveBeenCalled()
    expect(deleteAttachment).toHaveBeenCalledWith(201)
  })
})
