import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { WorkbenchMessage } from '@/types/workbench'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'

interface MessageListProps {
  messages: WorkbenchMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return null
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 overflow-x-hidden px-6 py-8">
      {messages.map(message => (
        <article
          key={message.id}
          className={[
            'min-w-0 overflow-x-hidden',
            message.role === 'user' ? 'flex justify-end' : '',
          ].join(' ')}
          data-testid={`message-${message.role}`}
        >
          {message.role === 'user' ? (
            <UserMessage content={message.content} />
          ) : (
            <AssistantMessage message={message} />
          )}
        </article>
      ))}
    </div>
  )
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="max-w-[80%] overflow-hidden break-words whitespace-pre-wrap rounded-2xl bg-primary/15 px-4 py-3 text-[13px] leading-5 text-text-primary">
      {content}
    </div>
  )
}

function AssistantMessage({ message }: { message: WorkbenchMessage }) {
  const hasBlocks = message.blocks && message.blocks.length > 0
  const hasContent = Boolean(message.content)
  const isStreaming = message.status === 'streaming'
  const isThinking = isStreaming && !hasContent && !hasBlocks

  return (
    <div className="min-w-0 overflow-x-hidden text-[13px] leading-6 text-text-primary">
      {hasBlocks && (
        <ToolBlocksDisplay
          blocks={message.blocks!}
          isStreaming={isStreaming}
        />
      )}
      {hasContent && (
        <div className="assistant-markdown min-w-0 overflow-x-hidden break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1 className="mb-4 mt-6 text-lg font-semibold">{children}</h1>,
              h2: ({ children }) => <h2 className="mb-3 mt-5 text-base font-semibold">{children}</h2>,
              h3: ({ children }) => <h3 className="mb-2 mt-4 text-sm font-semibold">{children}</h3>,
              p: ({ children }) => <p className="mb-3 min-w-0 break-words leading-6">{children}</p>,
              ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>,
              ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
              li: ({ children }) => <li className="min-w-0 break-words leading-6">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              code: ({ className, children }) => {
                const isBlock = className?.includes('language-')
                if (isBlock) {
                  const lang = className?.replace('language-', '') ?? ''
                  return <CodeBlock lang={lang}>{children}</CodeBlock>
                }
                return (
                  <code className="break-words rounded bg-code-bg px-1.5 py-0.5 text-xs font-medium text-text-primary">
                    {children}
                  </code>
                )
              },
              pre: ({ children }) => <pre className="mb-3 mt-2 max-w-full overflow-hidden">{children}</pre>,
              blockquote: ({ children }) => (
                <blockquote className="mb-3 border-l-3 border-border pl-4 text-text-secondary">
                  {children}
                </blockquote>
              ),
              table: ({ children }) => (
                <div className="mb-3 max-w-full overflow-x-auto">
                  <table className="w-full min-w-max border-collapse text-[13px]">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>
              ),
              td: ({ children }) => (
                <td className="border-b border-border px-3 py-2">{children}</td>
              ),
              a: ({ href, children }) => (
                <a href={href} className="break-words text-primary underline" target="_blank" rel="noopener noreferrer">{children}</a>
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      )}
      {isThinking && (
        <span className="text-text-muted">正在思考</span>
      )}
      {isStreaming && hasContent && (
        <span className="text-text-muted">正在思考</span>
      )}
      {message.status === 'failed' && message.error && (
        <p className="mt-2 text-xs text-red-500">{message.error}</p>
      )}
    </div>
  )
}

function CodeBlock({ lang, children }: { lang: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = String(children).replace(/\n$/, '')

  const handleCopy = () => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <code className="block max-w-full overflow-hidden rounded-lg border border-border">
      <span className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5">
        <span className="text-xs text-text-muted">{lang || 'text'}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="p-0.5 text-text-muted hover:text-text-secondary"
          >
            {copied ? (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </span>
      </span>
      <span className="block max-w-full overflow-x-auto bg-code-bg px-4 py-3 font-mono text-xs leading-5 text-text-primary">
        {children}
      </span>
    </code>
  )
}
