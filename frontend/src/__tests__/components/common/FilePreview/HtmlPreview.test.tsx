// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HtmlPreview } from '@/components/common/FilePreview/preview-renderers/HtmlPreview'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'actions.loading': 'Loading',
        'actions.preview': 'Preview',
        'attachment.html.script_error': 'This page script failed',
        'attachment.html.view_source': 'View Source',
      })[key] ?? key,
  }),
}))

describe('HtmlPreview', () => {
  const content =
    '<!doctype html><html><head><title>Report</title></head><body><div>content</div></body></html>'

  it('shows a script error reported by the sandboxed frame', async () => {
    render(<HtmlPreview content={content} filename="report.html" />)

    const frame = document.querySelector('iframe')
    expect(frame).not.toBeNull()

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame?.contentWindow,
        data: {
          source: 'wegent-html-preview',
          type: 'script-error',
          message: 'LIB is not defined',
          line: 78,
        },
      })
    )
    fireEvent.load(frame as HTMLIFrameElement)

    await waitFor(() => {
      expect(screen.getByTestId('html-preview-script-error')).toHaveTextContent(
        'This page script failed (line 78): LIB is not defined'
      )
    })
  })

  it('ignores bridge messages from another window', async () => {
    render(<HtmlPreview content={content} filename="report.html" />)

    fireEvent(
      window,
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'wegent-html-preview',
          type: 'script-error',
          message: 'forged',
        },
      })
    )
    fireEvent.load(document.querySelector('iframe') as HTMLIFrameElement)

    await waitFor(() => {
      expect(screen.queryByTestId('html-preview-script-error')).not.toBeInTheDocument()
    })
  })
})
