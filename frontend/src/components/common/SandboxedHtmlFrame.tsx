// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { CSSProperties, forwardRef } from 'react'

export interface SandboxedHtmlFrameProps {
  content: string
  title: string
  sandbox?: string
  className?: string
  style?: CSSProperties
  testId?: string
  onLoad?: () => void
  onError?: () => void
  /** Inject the bridge that reports frame script errors to the parent page. */
  reportScriptErrors?: boolean
}

const SCRIPT_ERROR_BRIDGE = `<script>
(function(){
  function report(error, line){
    try {
      parent.postMessage(
        {
          source: 'wegent-html-preview',
          type: 'script-error',
          message: error && error.message
            ? String(error.message)
            : String(error || 'Unhandled promise rejection'),
          line: line ? Number(line) : undefined
        },
        '*'
      );
    } catch (e) {}
  }
  window.addEventListener('error', function(event) { report(event, event.lineno); });
  window.addEventListener('unhandledrejection', function(event) { report(event.reason); });
})();
</script>`

function prependErrorBridge(content: string): string {
  if (/<head(\s[^>]*)?>/i.test(content)) {
    return content.replace(
      /<head(\s[^>]*)?>/i,
      (_match, attributes: string | undefined) => `<head${attributes ?? ''}>${SCRIPT_ERROR_BRIDGE}`
    )
  }
  if (/<html[^>]*>/i.test(content)) {
    return content.replace(
      /<html([^>]*)>/i,
      (_match, attributes: string) => `<html${attributes}><head>${SCRIPT_ERROR_BRIDGE}</head>`
    )
  }
  return SCRIPT_ERROR_BRIDGE + content
}

export const SandboxedHtmlFrame = forwardRef<HTMLIFrameElement, SandboxedHtmlFrameProps>(
  function SandboxedHtmlFrame(
    {
      content,
      title,
      sandbox = 'allow-scripts',
      className,
      style,
      testId,
      onLoad,
      onError,
      reportScriptErrors,
    },
    ref
  ) {
    const srcDoc = reportScriptErrors ? prependErrorBridge(content) : content

    return (
      <iframe
        ref={ref}
        title={title}
        srcDoc={srcDoc}
        sandbox={sandbox}
        className={className}
        style={style}
        data-testid={testId}
        onLoad={onLoad}
        onError={onError}
        data-artifact-script-error-reporting={reportScriptErrors ? 'on' : undefined}
      />
    )
  }
)
