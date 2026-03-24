// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useRef } from 'react'
import Prism from 'prismjs'
import { getPrismLanguage } from '../utils'
import { useTheme } from '@/features/theme/ThemeProvider'

// Import Prism core styles - use tomorrow theme (VS Code like dark theme)
import 'prismjs/themes/prism-tomorrow.css'

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
  }, [content, language, isDarkMode])

  // Split content into lines for rendering with line numbers
  const lines = content.split('\n')

  // Theme colors based on dark/light mode - VS Code Dark+ theme
  const themeColors = isDarkMode
    ? {
        bg: '#1e1e1e', // VS Code editor background
        lineNumberBg: '#1e1e1e', // Same as editor
        lineNumberColor: '#858585', // VS Code line numbers
        hoverBg: '#2a2d2e', // VS Code hover highlight
        borderColor: '#333', // Subtle border
        textColor: '#d4d4d4', // VS Code default text
      }
    : {
        bg: '#f5f2f0',
        lineNumberBg: '#e8e5e3',
        lineNumberColor: '#999',
        hoverBg: '#e0ddd9',
        borderColor: '#ccc',
        textColor: '#333',
      }

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: themeColors.bg }}>
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => (
              <tr
                key={index}
                className="transition-colors"
                style={{ backgroundColor: 'transparent' }}
                onMouseEnter={e => {
                  e.currentTarget.style.backgroundColor = themeColors.hoverBg
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
                    backgroundColor: themeColors.lineNumberBg,
                    color: themeColors.lineNumberColor,
                    borderColor: themeColors.borderColor,
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
                          color: language === 'text' ? themeColors.textColor : undefined,
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
                          color: language === 'text' ? themeColors.textColor : undefined,
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
