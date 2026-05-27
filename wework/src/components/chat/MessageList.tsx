import type { WorkbenchMessage } from '@/types/workbench'

interface MessageListProps {
  messages: WorkbenchMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return null
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">
      {messages.map(message => (
        <article
          key={message.id}
          className={message.role === 'user' ? 'ml-auto max-w-[82%]' : 'mr-auto max-w-[88%]'}
          data-testid={`message-${message.role}`}
        >
          <div
            className={[
              'whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6',
              message.role === 'user'
                ? 'bg-[#242424] text-white'
                : 'bg-surface text-text-primary',
            ].join(' ')}
          >
            {message.content}
            {message.status === 'streaming' && <span className="ml-1 animate-pulse">|</span>}
          </div>
          {message.status === 'failed' && message.error && (
            <p className="mt-2 text-xs text-red-500">{message.error}</p>
          )}
        </article>
      ))}
    </div>
  )
}
