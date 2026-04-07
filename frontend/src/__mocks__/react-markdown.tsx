// Mock for react-markdown to avoid ESM issues in Jest
import type { ReactNode } from 'react'

interface ReactMarkdownProps {
  children?: string
  components?: Record<string, React.ComponentType<{ children?: ReactNode; className?: string }>>
}

export default function ReactMarkdown({ children, components: _components }: ReactMarkdownProps) {
  // Simple mock that just renders the text content
  if (!children) return null

  // Split by newlines and wrap in divs to preserve some formatting
  const lines = children.split('\n')
  return (
    <div data-testid="react-markdown-mock">
      {lines.map((line, index) => (
        <div key={index}>{line || ' '}</div>
      ))}
    </div>
  )
}
