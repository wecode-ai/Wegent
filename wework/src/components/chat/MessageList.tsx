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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      {messages.map(message => (
        <article
          key={message.id}
          className={message.role === 'user' ? 'flex justify-end' : ''}
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
    <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[#f4f4f4] px-4 py-3 text-sm leading-6 text-[#1a1a1a]">
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
    <div className="text-sm leading-7 text-[#1a1a1a]">
      {hasBlocks && (
        <ToolBlocksDisplay
          blocks={message.blocks!}
          isStreaming={isStreaming}
        />
      )}
      {hasContent && (
        <div className="assistant-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1 className="mb-4 mt-6 text-xl font-semibold">{children}</h1>,
              h2: ({ children }) => <h2 className="mb-3 mt-5 text-lg font-semibold">{children}</h2>,
              h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
              p: ({ children }) => <p className="mb-3 leading-7">{children}</p>,
              ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>,
              ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
              li: ({ children }) => <li className="leading-7">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              code: ({ className, children }) => {
                const isBlock = className?.includes('language-')
                if (isBlock) {
                  const lang = className?.replace('language-', '') ?? ''
                  return <CodeBlock lang={lang}>{children}</CodeBlock>
                }
                return (
                  <code className="rounded bg-[#f0f0f0] px-1.5 py-0.5 text-xs font-medium text-[#1a1a1a]">
                    {children}
                  </code>
                )
              },
              pre: ({ children }) => <pre className="mb-3 mt-2">{children}</pre>,
              blockquote: ({ children }) => (
                <blockquote className="mb-3 border-l-3 border-[#e0e0e0] pl-4 text-[#666]">
                  {children}
                </blockquote>
              ),
              table: ({ children }) => (
                <div className="mb-3 overflow-x-auto">
                  <table className="w-full border-collapse text-sm">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b border-[#e0e0e0] px-3 py-2 text-left font-semibold">{children}</th>
              ),
              td: ({ children }) => (
                <td className="border-b border-[#e0e0e0] px-3 py-2">{children}</td>
              ),
              a: ({ href, children }) => (
                <a href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{children}</a>
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      )}
      {isThinking && (
        <span className="text-[#999]">正在思考</span>
      )}
      {isStreaming && hasContent && (
        <span className="text-[#999]">正在思考</span>
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
    <code className="block overflow-hidden rounded-lg border border-[#e0e0e0]">
      <span className="flex items-center justify-between border-b border-[#e0e0e0] bg-white px-3 py-1.5">
        <span className="text-xs text-[#999]">{lang || 'text'}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="p-0.5 text-[#999] hover:text-[#666]"
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
      <span className="block overflow-x-auto bg-white px-4 py-3 font-mono text-xs leading-5 text-[#1a1a1a]">
        {children}
      </span>
    </code>
  )
}
