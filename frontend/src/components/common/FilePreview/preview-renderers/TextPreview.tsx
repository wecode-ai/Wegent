// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useRef } from 'react'
import Prism from 'prismjs'
import { getPrismLanguage } from '../utils'
import { useTheme } from '@/features/theme/ThemeProvider'

// Import Prism theme with CSS variables support
import 'prism-theme-vars/base.css'

// Import common languages
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-scss'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-powershell'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-markdown'

interface TextPreviewProps {
  content: string
  filename: string
}

export function TextPreview({ content, filename }: TextPreviewProps) {
  const language = getPrismLanguage(filename)
  const codeRef = useRef<HTMLElement>(null)
  const { theme } = useTheme()
  const isDarkMode = theme === 'dark'

  // Apply syntax highlighting for code files
  useEffect(() => {
    if (codeRef.current && content && language !== 'text') {
      Prism.highlightElement(codeRef.current)
    }
  }, [content, language])

  // Split content into lines for rendering with line numbers
  const lines = content.split('\n')

  return (
    <div
      className="flex flex-col h-full"
      style={
        {
          backgroundColor: 'var(--prism-background)',
          '--prism-scheme': isDarkMode ? 'dark' : 'light',
          '--prism-foreground': isDarkMode ? '#d4d4d4' : '#333',
          '--prism-background': isDarkMode ? '#1e1e1e' : '#ffffff',
          '--prism-comment': isDarkMode ? '#6a9955' : '#008000',
          '--prism-string': isDarkMode ? '#ce9178' : '#a31515',
          '--prism-literal': isDarkMode ? '#569cd6' : '#0000ff',
          '--prism-keyword': isDarkMode ? '#569cd6' : '#0000ff',
          '--prism-function': isDarkMode ? '#dcdcaa' : '#795e26',
          '--prism-deleted': isDarkMode ? '#ce9178' : '#a31515',
          '--prism-class': isDarkMode ? '#4ec9b0' : '#267f99',
          '--prism-builtin': isDarkMode ? '#4ec9b0' : '#267f99',
          '--prism-property': isDarkMode ? '#9cdcfe' : '#001080',
          '--prism-namespace': isDarkMode ? '#4ec9b0' : '#267f99',
          '--prism-punctuation': isDarkMode ? '#d4d4d4' : '#333',
          '--prism-line-number': isDarkMode ? '#858585' : '#666',
          '--prism-line-number-gutter': isDarkMode ? '#333' : '#ddd',
          '--prism-line-highlight-background': isDarkMode ? '#2a2d2e' : '#f5f5f5',
          '--prism-selection-background': isDarkMode ? '#264f78' : '#add6ff',
        } as React.CSSProperties
      }
    >
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => (
              <tr
                key={index}
                className="transition-colors"
                style={{ backgroundColor: 'transparent' }}
                onMouseEnter={e => {
                  e.currentTarget.style.backgroundColor = 'var(--prism-line-highlight-background)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.backgroundColor = 'transparent'
                }}
              >
                {/* Line number cell */}
                <td
                  className="text-right select-none font-mono text-sm py-0 px-4 border-r"
                  style={{
                    minWidth: '3.5rem',
                    backgroundColor: 'var(--prism-background)',
                    color: 'var(--prism-line-number)',
                    borderColor: 'var(--prism-line-number-gutter)',
                  }}
                >
                  {index + 1}
                </td>
                {/* Code cell */}
                <td className="w-full py-0 px-4">
                  <pre
                    className="m-0 p-0 bg-transparent font-mono text-sm"
                    style={{
                      margin: 0,
                      padding: 0,
                      background: 'transparent',
                      lineHeight: '1.5',
                    }}
                  >
                    {index === 0 ? (
                      <code
                        ref={codeRef}
                        className={language !== 'text' ? `language-${language}` : undefined}
                        style={{
                          background: 'transparent',
                          textShadow: 'none',
                          padding: 0,
                          margin: 0,
                        }}
                      >
                        {line || ' '}
                      </code>
                    ) : (
                      <code
                        className={language !== 'text' ? `language-${language}` : undefined}
                        style={{
                          background: 'transparent',
                          textShadow: 'none',
                          padding: 0,
                          margin: 0,
                        }}
                      >
                        {line || ' '}
                      </code>
                    )}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
