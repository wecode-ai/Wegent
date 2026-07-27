// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { DocumentPanel } from '@/features/knowledge/document/components/DocumentPanel'
import type { KnowledgeBase } from '@/types/knowledge'

const mockDocumentDetailDialog = jest.fn((_props: unknown) => null)
const mockArtifactSourceSelector = jest.fn((_props: unknown) => null)
const mockSourceContinuation = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactPanel', () => ({
  ArtifactPanel: ({
    onCanManageChange,
    onAdjustSources,
  }: {
    onCanManageChange?: (canManage: boolean) => void
    onAdjustSources: (continuation: () => void) => void
  }) => (
    <>
      <button data-testid="mock-read-only-permission" onClick={() => onCanManageChange?.(false)} />
      <button data-testid="mock-editor-permission" onClick={() => onCanManageChange?.(true)} />
      <button
        data-testid="mock-adjust-sources"
        onClick={() => onAdjustSources(mockSourceContinuation)}
      />
    </>
  ),
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceDialog', () => ({
  ArtifactSourceDialog: ({
    open,
    onOpenChange,
    onApply,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onApply: (documentIds: number[]) => void
  }) =>
    open ? (
      <>
        <button data-testid="mock-source-cancel" onClick={() => onOpenChange(false)} />
        <button data-testid="mock-source-apply" onClick={() => onApply([11])} />
      </>
    ) : null,
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceSelector', () => ({
  ArtifactSourceSelector: (props: unknown) => mockArtifactSourceSelector(props),
}))

jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: (props: unknown) => mockDocumentDetailDialog(props),
}))

const knowledgeBase: KnowledgeBase = {
  id: 12,
  name: 'organization-kb',
  description: null,
  user_id: 7,
  namespace: 'organization-name',
  document_count: 3,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 0,
  created_at: '2026-07-27T00:00:00Z',
  updated_at: '2026-07-27T00:00:00Z',
}

describe('DocumentPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('forwards organization routing context to document preview', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} isOrganization canManageKb />)

    expect(mockDocumentDetailDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isOrganization: true,
        knowledgeBaseName: 'organization-kb',
        knowledgeBaseNamespace: 'organization-name',
        canEdit: true,
      })
    )
  })

  it('expands sources by default only for read-only users', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} />)

    expect(mockArtifactSourceSelector).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultDocumentsExpanded: undefined })
    )

    fireEvent.click(screen.getByTestId('mock-read-only-permission'))
    expect(mockArtifactSourceSelector).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultDocumentsExpanded: true,
        purpose: 'question',
      })
    )
    expect(screen.getByText('artifact.sourceBrowser.documents')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mock-editor-permission'))
    expect(mockArtifactSourceSelector).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultDocumentsExpanded: false,
        purpose: 'workspace',
      })
    )
    expect(screen.getByText('artifact.source')).toBeInTheDocument()
  })

  it('resumes creation only after applying source changes', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} />)

    fireEvent.click(screen.getByTestId('mock-adjust-sources'))
    fireEvent.click(screen.getByTestId('mock-source-cancel'))
    expect(mockSourceContinuation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('mock-adjust-sources'))
    fireEvent.click(screen.getByTestId('mock-source-apply'))
    expect(mockSourceContinuation).toHaveBeenCalledTimes(1)
  })
})
