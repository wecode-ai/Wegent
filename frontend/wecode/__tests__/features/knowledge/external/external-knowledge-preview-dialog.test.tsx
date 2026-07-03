// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { ExternalKnowledgePreviewDialog } from '@wecode/features/knowledge/external/components/ExternalKnowledgePreviewDialog'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: {
    children: React.ReactNode
  } & React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

describe('ExternalKnowledgePreviewDialog', () => {
  it('sandboxes iframe previews and suppresses referrer leakage', () => {
    render(
      <ExternalKnowledgePreviewDialog
        open
        onOpenChange={jest.fn()}
        preview={{
          url: 'https://apgateway.erp.sina.com.cn/proxy/preview',
          preview_mode: 'iframe',
        }}
        title="Plan.pdf"
        testId="external-knowledge-preview-dialog"
        iframeTestId="external-knowledge-preview-iframe"
      />
    )

    const iframe = screen.getByTestId('external-knowledge-preview-iframe')
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
  })
})
