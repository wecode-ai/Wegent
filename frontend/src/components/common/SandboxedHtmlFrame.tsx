// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { CSSProperties } from 'react'

export interface SandboxedHtmlFrameProps {
  content: string
  title: string
  sandbox?: string
  className?: string
  style?: CSSProperties
  testId?: string
  onLoad?: () => void
  onError?: () => void
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
}: SandboxedHtmlFrameProps) {
  return (
    <iframe
      title={title}
      srcDoc={content}
      sandbox={sandbox}
      className={className}
      style={style}
      data-testid={testId}
      onLoad={onLoad}
      onError={onError}
    />
  )
}
