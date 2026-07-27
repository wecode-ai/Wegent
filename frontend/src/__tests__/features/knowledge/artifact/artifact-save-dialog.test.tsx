// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createTextKnowledgeDocument } from '@/apis/knowledge'
import { ArtifactSaveDialog } from '@/features/knowledge/artifact/components/ArtifactSaveDialog'

jest.mock('@/apis/knowledge', () => ({
  createTextKnowledgeDocument: jest.fn(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/components/common/WysiwygEditor', () => ({
  WysiwygEditor: ({
    initialContent,
    onChange,
  }: {
    initialContent: string
    onChange: (content: string) => void
  }) => (
    <textarea
      data-testid="artifact-save-content-input"
      defaultValue={initialContent}
      onChange={event => onChange(event.target.value)}
    />
  ),
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

describe('ArtifactSaveDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(createTextKnowledgeDocument as jest.Mock).mockResolvedValue({ id: 42 })
  })

  it('saves normalized briefing content through the text document API', async () => {
    const onSaved = jest.fn()
    const onOpenChange = jest.fn()
    render(
      <ArtifactSaveDialog
        open
        onOpenChange={onOpenChange}
        knowledgeBaseId={12}
        initialTitle="Initial"
        initialContent="Initial content"
        onSaved={onSaved}
      />
    )

    fireEvent.change(screen.getByTestId('artifact-save-title-input'), {
      target: { value: '  Weekly briefing  ' },
    })
    fireEvent.change(screen.getByTestId('artifact-save-content-input'), {
      target: { value: '  # Summary  ' },
    })
    fireEvent.click(screen.getByTestId('artifact-save-submit'))

    await waitFor(() =>
      expect(createTextKnowledgeDocument).toHaveBeenCalledWith({
        knowledge_base_id: 12,
        name: 'Weekly briefing',
        content: '# Summary',
      })
    )
    expect(screen.getByTestId('artifact-save-submit')).toHaveClass('bg-primary')
    expect(onSaved).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
