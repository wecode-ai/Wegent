// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactCreateDialog } from '@/features/knowledge/artifact/components/ArtifactCreateDialog'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('ArtifactCreateDialog', () => {
  it('makes the whole knowledge base an explicit source and submits an empty document filter', async () => {
    const onCreate = jest.fn().mockResolvedValue(undefined)
    render(
      <ArtifactCreateDialog
        open={true}
        onOpenChange={jest.fn()}
        artifactType="briefing"
        selectedDocumentIds={[]}
        knowledgeBaseDocumentCount={36}
        onAdjustSources={jest.fn()}
        onCreate={onCreate}
      />
    )

    expect(screen.getByText('artifact.action.briefing').parentElement).toContainElement(
      screen.getByText('artifact.createDescription')
    )
    expect(screen.queryByText('artifact.type.briefingHint')).not.toBeInTheDocument()
    expect(screen.getByText('artifact.wholeKnowledgeBase:36')).toBeInTheDocument()
    expect(screen.getByText('artifact.sharedGenerationNotice')).toBeInTheDocument()
    expect(screen.getByTestId('artifact-create-dialog')).toHaveClass('sm:max-w-3xl')
    fireEvent.change(screen.getByTestId('artifact-title-input'), {
      target: { value: '  Weekly briefing  ' },
    })
    fireEvent.change(screen.getByTestId('artifact-instruction-input'), {
      target: { value: '  Focus on risks  ' },
    })
    fireEvent.click(screen.getByTestId('artifact-create-submit'))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        artifact_type: 'briefing',
        document_ids: [],
        title: 'Weekly briefing',
        instruction: 'Focus on risks',
      })
    )
  })

  it('keeps the selected capability and explicit document scope', async () => {
    const onCreate = jest.fn().mockResolvedValue(undefined)
    const onAdjustSources = jest.fn()
    render(
      <ArtifactCreateDialog
        open={true}
        onOpenChange={jest.fn()}
        artifactType="mind_map"
        selectedDocumentIds={[11, 12]}
        knowledgeBaseDocumentCount={36}
        onAdjustSources={onAdjustSources}
        onCreate={onCreate}
      />
    )

    expect(screen.getByText('artifact.action.mind_map')).toBeInTheDocument()
    expect(screen.queryByText('artifact.type.mindMapHint')).not.toBeInTheDocument()
    expect(screen.getByText('artifact.selectedDocuments:2')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('artifact-create-adjust-sources'))
    expect(onAdjustSources).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('artifact-create-submit'))
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        artifact_type: 'mind_map',
        document_ids: [11, 12],
      })
    )
  })

  it('preserves the generation draft while sources are being adjusted', () => {
    const props = {
      onOpenChange: jest.fn(),
      artifactType: 'briefing' as const,
      selectedDocumentIds: [] as number[],
      knowledgeBaseDocumentCount: 36,
      onAdjustSources: jest.fn(),
      onCreate: jest.fn().mockResolvedValue(undefined),
    }
    const { rerender } = render(<ArtifactCreateDialog {...props} open={true} />)

    fireEvent.change(screen.getByTestId('artifact-title-input'), {
      target: { value: 'Draft title' },
    })
    fireEvent.change(screen.getByTestId('artifact-instruction-input'), {
      target: { value: 'Draft instruction' },
    })

    rerender(<ArtifactCreateDialog {...props} open={false} />)
    rerender(<ArtifactCreateDialog {...props} open={true} selectedDocumentIds={[11, 12]} />)

    expect(screen.getByTestId('artifact-title-input')).toHaveValue('Draft title')
    expect(screen.getByTestId('artifact-instruction-input')).toHaveValue('Draft instruction')
    expect(screen.getByText('artifact.selectedDocuments:2')).toBeInTheDocument()
  })

  it('keeps the dialog retryable when creation is rejected', async () => {
    const onCreate = jest.fn().mockRejectedValue(new Error('creation failed'))
    const onOpenChange = jest.fn()
    render(
      <ArtifactCreateDialog
        open
        onOpenChange={onOpenChange}
        artifactType="briefing"
        selectedDocumentIds={[]}
        knowledgeBaseDocumentCount={1}
        onAdjustSources={jest.fn()}
        onCreate={onCreate}
      />
    )

    fireEvent.click(screen.getByTestId('artifact-create-submit'))

    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('artifact-create-submit')).toBeEnabled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId('artifact-create-dialog')).toBeInTheDocument()
  })
})
