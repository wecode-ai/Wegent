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
  /** A frame-internal error reported through the postMessage bridge. */
  onScriptError?: (message: string, line?: number) => void
}

const SCRIPT_ERROR_BRIDGE = `<script>
(function(){
  function report(error){
    try {
      parent.postMessage(
        {
          source: 'wegent-html-preview',
          type: 'script-error',
          message: error && error.message ? String(error.message) : String(error),
          line: event.lineno ? Number(event.lineno) : undefined
        },
        '*'
      );
    } catch (e) {}
  }
  window.addEventListener('error', function(event) { report(event); });
  window.addEventListener('unhandledrejection', function(event) { report(event.reason); });
})();
</script>`

function prependErrorBridge(content: string): string {
  if (/<head[^>]*>/i.test(content)) {
    return content.replace(
      /<head([^>]*)>/i,
      (_match, attributes: string) => `<head${attributes}>${SCRIPT_ERROR_BRIDGE}`
    )
  }
  return content.replace(
    /<html([^>]*)>/i,
    (_match, attributes: string) => `<html${attributes}><head>${SCRIPT_ERROR_BRIDGE}</head>`
  )
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
      onScriptError,
    },
    ref
  ) {
    const srcDoc = onScriptError ? prependErrorBridge(content) : content

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
      />
    )
  }
)
