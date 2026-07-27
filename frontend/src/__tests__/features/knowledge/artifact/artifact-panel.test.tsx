// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactPanel } from '@/features/knowledge/artifact/components/ArtifactPanel'
import { useKnowledgeArtifacts } from '@/features/knowledge/artifact/hooks/useKnowledgeArtifacts'
import type {
  ArtifactPromptRequest,
  KnowledgeArtifact,
  KnowledgeArtifactCreate,
} from '@/types/knowledge-artifact'

const createMock = jest.fn()
const removeMock = jest.fn()
const toastMock = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
    i18n: { language: 'zh-CN' },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

jest.mock('@/features/knowledge/artifact/hooks/useKnowledgeArtifacts', () => ({
  useKnowledgeArtifacts: jest.fn(),
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactCreateDialog', () => ({
  ArtifactCreateDialog: ({
    open,
    artifactType,
    selectedDocumentIds,
    onCreate,
  }: {
    open: boolean
    artifactType: KnowledgeArtifactCreate['artifact_type']
    selectedDocumentIds: number[]
    onCreate: (request: KnowledgeArtifactCreate) => Promise<void>
  }) =>
    open ? (
      <button
        data-testid="mock-create-submit"
        onClick={() =>
          void onCreate({
            artifact_type: artifactType,
            document_ids: selectedDocumentIds,
          })
        }
      >
        submit {artifactType}
      </button>
    ) : null,
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactViewer', () => ({
  ArtifactViewer: ({
    artifact,
    onAskNode,
    onDelete,
  }: {
    artifact: KnowledgeArtifact | null
    onAskNode?: (request: ArtifactPromptRequest) => void
    onDelete: () => Promise<void>
  }) =>
    artifact ? (
      <>
        <button
          data-testid="mock-artifact-viewer"
          onClick={() =>
            onAskNode?.({
              requestId: 'request-1',
              message: '解释节点',
              artifactContext: {
                artifact_id: artifact.artifact_id,
                node_id: 'node-1',
              },
            })
          }
        />
        <button data-testid="mock-viewer-delete" onClick={() => void onDelete()} />
      </>
    ) : null,
}))

describe('ArtifactPanel AI Workshop', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useKnowledgeArtifacts as jest.Mock).mockReturnValue({
      items: [],
      canManage: true,
      availableDocumentCount: 36,
      processingDocumentCount: 0,
      isLoading: false,
      error: null,
      create: createMock,
      rename: jest.fn(),
      retry: jest.fn(),
      remove: removeMock,
      refresh: jest.fn(),
    })
    createMock.mockResolvedValue({ artifact_id: 'artifact-1' })
    removeMock.mockResolvedValue(undefined)
  })

  it('shows compact capability cards and creates from the whole knowledge base by default', async () => {
    render(
      <ArtifactPanel knowledgeBaseId={12} selectedDocumentIds={[]} onAdjustSources={jest.fn()} />
    )

    expect(screen.getByText('artifact.action.briefing')).toBeInTheDocument()
    expect(screen.getByText('artifact.action.mind_map')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('artifact-type-briefing'))
    fireEvent.click(screen.getByTestId('mock-create-submit'))

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        artifact_type: 'briefing',
        document_ids: [],
      })
    )
    expect(screen.queryByTestId('mock-artifact-viewer')).not.toBeInTheDocument()
    expect(toastMock).toHaveBeenCalledWith({ description: 'artifact.started' })
  })

  it('reports generation permission and processing state to the source browser', async () => {
    const onCanManageChange = jest.fn()
    const onProcessingDocumentCountChange = jest.fn()

    render(
      <ArtifactPanel
        knowledgeBaseId={12}
        selectedDocumentIds={[]}
        onAdjustSources={jest.fn()}
        onCanManageChange={onCanManageChange}
        onProcessingDocumentCountChange={onProcessingDocumentCountChange}
      />
    )

    await waitFor(() => {
      expect(onCanManageChange).toHaveBeenCalledWith(true)
      expect(onProcessingDocumentCountChange).toHaveBeenCalledWith(0)
    })
  })

  it('passes explicitly selected sources to a specialized capability', async () => {
    render(
      <ArtifactPanel
        knowledgeBaseId={12}
        selectedDocumentIds={[11, 12]}
        onAdjustSources={jest.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('artifact-type-mind-map'))
    fireEvent.click(screen.getByTestId('mock-create-submit'))

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        artifact_type: 'mind_map',
        document_ids: [11, 12],
      })
    )
  })

  it('limits read-only knowledge base users to viewing artifacts', () => {
    ;(useKnowledgeArtifacts as jest.Mock).mockReturnValue({
      items: [],
      canManage: false,
      availableDocumentCount: 36,
      processingDocumentCount: 0,
      isLoading: false,
      error: null,
      create: createMock,
      rename: jest.fn(),
      retry: jest.fn(),
      remove: jest.fn(),
      refresh: jest.fn(),
    })

    render(
      <ArtifactPanel knowledgeBaseId={12} selectedDocumentIds={[]} onAdjustSources={jest.fn()} />
    )

    expect(screen.queryByTestId('artifact-type-briefing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('artifact-type-mind-map')).not.toBeInTheDocument()
    expect(screen.getByText('artifact.emptyReadOnlyHint')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('closes the viewer and forwards a node question to the workspace', () => {
    const onAskNode = jest.fn()
    ;(useKnowledgeArtifacts as jest.Mock).mockReturnValue({
      items: [
        {
          artifact_id: 'artifact-1',
          artifact_type: 'mind_map',
          title: '主题导图',
          status: 'succeeded',
          source_document_ids: [101],
          created_at: '2026-07-26T12:00:00+08:00',
        },
      ],
      canManage: false,
      availableDocumentCount: 1,
      processingDocumentCount: 0,
      isLoading: false,
      error: null,
      create: createMock,
      rename: jest.fn(),
      retry: jest.fn(),
      remove: jest.fn(),
      refresh: jest.fn(),
    })

    render(
      <ArtifactPanel
        knowledgeBaseId={12}
        selectedDocumentIds={[]}
        onAdjustSources={jest.fn()}
        onAskNode={onAskNode}
      />
    )

    fireEvent.click(screen.getByTestId('artifact-card-artifact-1'))
    fireEvent.click(screen.getByTestId('mock-artifact-viewer'))

    expect(onAskNode).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactContext: {
          artifact_id: 'artifact-1',
          node_id: 'node-1',
        },
      })
    )
    expect(screen.queryByTestId('mock-artifact-viewer')).not.toBeInTheDocument()
  })

  it('explains why generation is unavailable while documents are processing', () => {
    ;(useKnowledgeArtifacts as jest.Mock).mockReturnValue({
      items: [],
      canManage: true,
      availableDocumentCount: 0,
      processingDocumentCount: 1,
      isLoading: false,
      error: null,
      create: createMock,
      rename: jest.fn(),
      retry: jest.fn(),
      remove: jest.fn(),
      refresh: jest.fn(),
    })

    render(
      <ArtifactPanel knowledgeBaseId={12} selectedDocumentIds={[]} onAdjustSources={jest.fn()} />
    )

    expect(screen.getByText('artifact.documentsProcessingHint')).toBeInTheDocument()
    expect(screen.getByTestId('artifact-type-briefing')).toBeDisabled()
  })

  it('routes viewer deletion through the shared alert dialog', async () => {
    ;(useKnowledgeArtifacts as jest.Mock).mockReturnValue({
      items: [
        {
          artifact_id: 'artifact-1',
          artifact_type: 'briefing',
          title: 'Briefing',
          status: 'succeeded',
          source_document_ids: [101],
          created_at: '2026-07-26T12:00:00+08:00',
          can_delete: true,
        },
      ],
      canManage: true,
      availableDocumentCount: 1,
      processingDocumentCount: 0,
      isLoading: false,
      error: null,
      create: createMock,
      rename: jest.fn(),
      retry: jest.fn(),
      remove: removeMock,
      refresh: jest.fn(),
    })

    render(
      <ArtifactPanel knowledgeBaseId={12} selectedDocumentIds={[]} onAdjustSources={jest.fn()} />
    )

    fireEvent.click(screen.getByTestId('artifact-card-artifact-1'))
    fireEvent.click(screen.getByTestId('mock-viewer-delete'))
    expect(removeMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('artifact-delete-confirm'))
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('artifact-1'))
  })
})
