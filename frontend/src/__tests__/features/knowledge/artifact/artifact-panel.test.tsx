// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactPanel } from '@/features/knowledge/artifact/components/ArtifactPanel'
import { useKnowledgeArtifacts } from '@/features/knowledge/artifact/hooks/useKnowledgeArtifacts'
import type { KnowledgeArtifactCreate } from '@/types/knowledge-artifact'

const createMock = jest.fn()
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
  ArtifactViewer: ({ artifact }: { artifact: unknown }) =>
    artifact ? <div data-testid="mock-artifact-viewer" /> : null,
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
      remove: jest.fn(),
      refresh: jest.fn(),
    })
    createMock.mockResolvedValue({ artifact_id: 'artifact-1' })
  })

  it('shows large capability cards and creates from the whole knowledge base by default', async () => {
    render(
      <ArtifactPanel knowledgeBaseId={12} selectedDocumentIds={[]} onAdjustSources={jest.fn()} />
    )

    expect(screen.getByText('artifact.commonCapabilities')).toBeInTheDocument()
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

  it('allows read-only knowledge base users to generate artifacts', () => {
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

    expect(screen.getByTestId('artifact-type-briefing')).toBeEnabled()
    expect(screen.getByTestId('artifact-type-mind-map')).toBeEnabled()
  })

  it('explains why generation is unavailable while documents are processing', () => {
    ;(useKnowledgeArtifacts as jest.Mock).mockReturnValue({
      items: [],
      canManage: false,
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
})
