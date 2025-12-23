// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import MarkdownEditor from '@uiw/react-markdown-editor'
import { useTheme } from '@/features/theme/ThemeProvider'

interface MarkdownRendererProps {
  content: string
  className?: string
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const { theme } = useTheme()

  return (
    <div className={className}>
      <MarkdownEditor.Markdown
        source={content}
        style={{ background: 'transparent' }}
        wrapperElement={{ 'data-color-mode': theme }}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
        }}
      />
    </div>
  )
}

export default MarkdownRenderer
