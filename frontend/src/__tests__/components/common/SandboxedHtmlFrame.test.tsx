// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render } from '@testing-library/react'
import { SandboxedHtmlFrame } from '@/components/common/SandboxedHtmlFrame'

describe('SandboxedHtmlFrame', () => {
  it('injects the script error bridge when script errors are observed', () => {
    render(
      <SandboxedHtmlFrame
        content={
          '<!doctype html><html><head><title>Report</title></head><body><div>x</div></body></html>'
        }
        title="Report"
        onScriptError={jest.fn()}
      />
    )

    const frame = document.querySelector('iframe')
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining("source: 'wegent-html-preview'")
    )
  })

  it('keeps the original document when script errors are not observed', () => {
    const content = '<!doctype html><html><body><div>plain</div></body></html>'
    render(<SandboxedHtmlFrame content={content} title="Plain" />)

    const frame = document.querySelector('iframe')
    expect(frame).toHaveAttribute('srcdoc', content)
  })

  it('injects the bridge after an existing head element', () => {
    const content =
      '<!doctype html><html><head><title>Report</title></head><body><div>x</div></body></html>'
    render(<SandboxedHtmlFrame content={content} title="Report" onScriptError={() => undefined} />)

    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc.indexOf("source: 'wegent-html-preview'")).toBeGreaterThan(0)
    expect(srcdoc.indexOf("source: 'wegent-html-preview'")).toBeLessThan(srcdoc.indexOf('<title>'))
  })
})
