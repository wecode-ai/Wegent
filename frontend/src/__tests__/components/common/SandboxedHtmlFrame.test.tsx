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
        reportScriptErrors
      />
    )

    const frame = document.querySelector('iframe')
    expect(frame).toHaveAttribute('srcdoc', expect.stringContaining("source:'wegent-html-preview'"))
  })

  it('keeps the original document when script errors are not observed', () => {
    const content = '<!doctype html><html><body><div>plain</div></body></html>'
    render(<SandboxedHtmlFrame content={content} title="Plain" />)

    const frame = document.querySelector('iframe')
    expect(frame).toHaveAttribute('srcdoc', content)
  })

  it('injects the bridge without shifting original line numbers', () => {
    const content = '<div>fragment</div><script>throw new Error("line 5")</script>'
    render(<SandboxedHtmlFrame content={content} title="Report" reportScriptErrors />)

    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).not.toContain('\n')
    expect(srcdoc.endsWith(content)).toBe(true)
  })

  it('injects the bridge after an existing head element', () => {
    const content =
      '<!doctype html><html><head><title>Report</title></head><body><div>x</div></body></html>'
    render(<SandboxedHtmlFrame content={content} title="Report" reportScriptErrors />)

    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc.indexOf("source:'wegent-html-preview'")).toBeGreaterThan(0)
    expect(srcdoc.indexOf("source:'wegent-html-preview'")).toBeLessThan(srcdoc.indexOf('<title>'))
  })

  it('does not treat a header element as the document head', () => {
    const content = '<html><body><header><h1>Report</h1></header></body></html>'
    render(<SandboxedHtmlFrame content={content} title="Report" reportScriptErrors />)

    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('<head>')
    expect(srcdoc.indexOf("source:'wegent-html-preview'")).toBeLessThan(srcdoc.indexOf('<header>'))
  })

  it('injects the bridge into a head tag with attributes', () => {
    const content = '<html><head lang="en"><title>Report</title></head></html>'
    render(<SandboxedHtmlFrame content={content} title="Report" reportScriptErrors />)

    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('<head lang="en">')
    expect(srcdoc.indexOf("source: 'wegent-html-preview'")).toBeLessThan(srcdoc.indexOf('<title>'))
  })

  it('prepends the bridge for an HTML fragment', () => {
    const content = '<div>fragment</div>'
    render(<SandboxedHtmlFrame content={content} title="Fragment" reportScriptErrors />)

    const srcdoc = document.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc.startsWith('<script>')).toBe(true)
    expect(srcdoc).toContain(content)
  })
})
