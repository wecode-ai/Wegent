import { deliveryMessages } from './deliveryMessages'
import { File } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import type { SharedIssueDetailDeliveryDetail } from './createSharedIssueDetailPort'
import { IssueActivityMarkdown } from './IssueActivityMarkdown'

export function IssueDeliveryContent({
  delivery,
  translate,
}: {
  delivery: SharedIssueDetailDeliveryDetail
  translate: CollaborationTranslate
}) {
  const messages = deliveryMessages(delivery.chat)

  return (
    <>
      {(delivery.markdown.trim() || (messages.length === 0 && delivery.assets.length === 0)) && (
        <article className="mt-6 rounded-lg bg-muted/40 p-4 text-sm leading-6 text-text-primary">
          <IssueActivityMarkdown
            content={delivery.markdown || translate('todo.no_delivery_description', '无交付说明')}
            translate={translate}
          />
        </article>
      )}
      {messages.length > 0 && (
        <section data-testid="todo-detail-delivery-chat" className="mt-6">
          <h3 className="text-xs font-semibold text-text-secondary">
            {translate('todo.delivery_conversation', '交付会话')}
          </h3>
          <div className="mt-3 space-y-4">
            {messages.map((message, index) => (
              <article key={index} className="text-sm leading-6 text-text-primary">
                <p className="mb-1 text-xs text-text-muted">
                  {message.role === 'user'
                    ? translate('todo.delivery_user', '用户')
                    : message.role === 'assistant'
                      ? translate('todo.delivery_assistant', '助手')
                      : message.role}
                </p>
                <IssueActivityMarkdown content={message.content} translate={translate} />
              </article>
            ))}
          </div>
        </section>
      )}
      {delivery.assets.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-semibold text-text-secondary">
            {translate('todo.attachment', '附件')}
          </h3>
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {delivery.assets.map(asset => (
              <div key={asset.id} className="flex h-10 items-center gap-2 px-3 text-sm">
                <File className="h-4 w-4 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">{asset.relative_path}</span>
                <span className="text-text-muted">{asset.size_bytes} B</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
