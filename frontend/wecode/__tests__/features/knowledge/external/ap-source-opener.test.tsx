// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceReferences } from '@/features/tasks/components/chat/SourceReferences'
import { getExternalKnowledgePreview } from '@wecode/api/external-knowledge'

jest.mock('@wecode/api/external-knowledge', () => ({
  getExternalKnowledgePreview: jest.fn(),
}))

jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@wecode/features/knowledge/external/components/ExternalKnowledgePreviewDialog', () => ({
  ExternalKnowledgePreviewDialog: ({
    open,
    preview,
  }: {
    open: boolean
    preview: { url: string } | null
  }) => (open && preview ? <div data-testid="mock-ap-preview-dialog">{preview.url}</div> : null),
}))

// Import for side-effect: registers the AP source opener.
import '@wecode/features/knowledge/external/ap-source-opener'

const mockPreview = getExternalKnowledgePreview as jest.MockedFunction<
  typeof getExternalKnowledgePreview
>

function renderApSource(sourceUri = 'ap://kb-1/doc-1') {
  return render(
    <SourceReferences
      sources={[
        {
          index: 1,
          title: 'Plan.pdf',
          source_type: 'ap',
          source_uri: sourceUri,
        },
      ]}
    />
  )
}

describe('AP source opener', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('opens AP-returned DingTalk previews in a new tab', async () => {
    window.open = jest.fn()
    mockPreview.mockResolvedValue({
      url: 'https://alidocs.dingtalk.com/i/nodes/doc-1',
      preview_mode: 'new_tab',
    })

    renderApSource()
    fireEvent.click(screen.getByTestId('ap-source-open-button-1'))

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith(
        'https://alidocs.dingtalk.com/i/nodes/doc-1',
        '_blank',
        'noopener,noreferrer'
      )
    })
    expect(screen.queryByTestId('mock-ap-preview-dialog')).not.toBeInTheDocument()
  })

  it('uses the iframe dialog for iframe-safe previews', async () => {
    window.open = jest.fn()
    mockPreview.mockResolvedValue({
      url: 'https://apgateway.erp.sina.com.cn/proxy/preview',
      preview_mode: 'iframe',
    })

    renderApSource()
    fireEvent.click(screen.getByTestId('ap-source-open-button-1'))

    expect(await screen.findByTestId('mock-ap-preview-dialog')).toHaveTextContent(
      'https://apgateway.erp.sina.com.cn/proxy/preview'
    )
    expect(window.open).not.toHaveBeenCalled()
  })

  it('preserves AP source id casing when resolving previews', async () => {
    window.open = jest.fn()
    mockPreview.mockResolvedValue({
      url: 'https://apgateway.erp.sina.com.cn/proxy/preview',
      preview_mode: 'iframe',
    })

    renderApSource('ap://Kb-ABC-1/Doc-XYZ-1')
    fireEvent.click(screen.getByTestId('ap-source-open-button-1'))

    await waitFor(() => {
      expect(mockPreview).toHaveBeenCalledWith('ap', {
        kb_id: 'Kb-ABC-1',
        document_id: 'Doc-XYZ-1',
      })
    })
  })
})
