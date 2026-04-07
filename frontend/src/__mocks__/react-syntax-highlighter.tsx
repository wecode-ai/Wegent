// Mock for react-syntax-highlighter to avoid ESM issues in Jest
import type { ReactNode } from 'react'

interface SyntaxHighlighterProps {
  children?: ReactNode
  language?: string
  style?: Record<string, unknown>
  className?: string
  PreTag?: string
}

export default function SyntaxHighlighter({ children, className }: SyntaxHighlighterProps) {
  return (
    <pre data-testid="syntax-highlighter-mock" className={className}>
      <code>{children}</code>
    </pre>
  )
}

// Also export a Light version
export function Light({ children, className }: SyntaxHighlighterProps) {
  return (
    <pre data-testid="syntax-highlighter-light-mock" className={className}>
      <code>{children}</code>
    </pre>
  )
}
