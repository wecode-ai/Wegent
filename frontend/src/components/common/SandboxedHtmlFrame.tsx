// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { CSSProperties, useEffect, useMemo, useRef } from 'react'

export const SANDBOXED_HTML_SEND_TO_CHAT_EVENT = 'wegent:sandboxed-html-send-to-chat'

export interface SandboxedHtmlFrameProps {
  content: string
  title: string
  sandbox?: string
  className?: string
  style?: CSSProperties
  testId?: string
  onLoad?: () => void
  onError?: () => void
  onSendMessage?: (content: string) => void
}

function buildSrcDoc(content: string, shouldInjectSendToChat: boolean): string {
  if (!shouldInjectSendToChat) return content

  const bridgeScript = [
    '<script>',
    '(function () {',
    '  window.sendToChat = function (message) {',
    `    window.parent.postMessage({ type: '${SANDBOXED_HTML_SEND_TO_CHAT_EVENT}', message: String(message || '') }, '*');`,
    '  };',
    '}());',
    '</script>',
  ].join('\n')

  if (/<head\b[^>]*>/i.test(content)) {
    return content.replace(/<head\b[^>]*>/i, match => `${match}\n${bridgeScript}`)
  }

  if (/<html\b[^>]*>/i.test(content)) {
    return content.replace(/<html\b[^>]*>/i, match => `${match}\n<head>${bridgeScript}</head>`)
  }

  return `${bridgeScript}\n${content}`
}

export function SandboxedHtmlFrame({
  content,
  title,
  sandbox = 'allow-scripts',
  className,
  style,
  testId,
  onLoad,
  onError,
  onSendMessage,
}: SandboxedHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const srcDoc = useMemo(
    () => buildSrcDoc(content, Boolean(onSendMessage)),
    [content, onSendMessage]
  )

  useEffect(() => {
    if (!onSendMessage) return

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; message?: unknown } | null
      if (!data || data.type !== SANDBOXED_HTML_SEND_TO_CHAT_EVENT) return
      if (typeof data.message !== 'string') return

      const message = data.message.trim()
      if (message) {
        onSendMessage(message)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [onSendMessage])

  return (
    <iframe
      ref={iframeRef}
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
