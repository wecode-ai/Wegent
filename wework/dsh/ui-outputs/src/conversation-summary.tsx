import { FileText, Globe2, Image, Paperclip, ScrollText } from 'lucide-react'
import type { ComponentType } from 'react'
import {
  WEWORK_HOST_SERVICES,
  type ConversationOutputsHostService,
  type ConversationOutputKind,
  type ConversationOutputSourceKind,
} from '@/features/dsh-runtime/conversationHostServices'
import type { ConversationSummarySurfaceProps } from '@/features/dsh-runtime/conversationSummarySurface'
import { useTranslation } from '@/hooks/useTranslation'

const OUTPUT_ICONS: Record<ConversationOutputKind, ComponentType<{ className?: string }>> = {
  file: FileText,
  image: Image,
  website: Globe2,
}

const SOURCE_ICONS: Record<ConversationOutputSourceKind, ComponentType<{ className?: string }>> = {
  attachment: Paperclip,
  memory: ScrollText,
  website: Globe2,
}

export default function OutputsConversationSummary({ services }: ConversationSummarySurfaceProps) {
  const { t } = useTranslation('common')
  const summary = services
    .getService<ConversationOutputsHostService>(WEWORK_HOST_SERVICES.conversationOutputs)
    ?.read()
  if (!summary) return null

  return (
    <div data-testid="conversation-output-summary">
      <h2 className="mb-3 text-sm font-medium text-text-primary">
        {t('workbench.output_summary_title', '输出内容')}
      </h2>

      {summary.outputs.length > 0 ? (
        <div className="space-y-0.5" data-testid="conversation-output-list">
          {summary.outputs.map(output => {
            const Icon = OUTPUT_ICONS[output.kind]
            return (
              <button
                key={output.id}
                type="button"
                data-testid={`conversation-output-item-${output.id}`}
                onClick={() => void services.openResource(output.resource)}
                className="flex h-9 w-full min-w-0 items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover"
                title={output.title}
              >
                <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{output.title}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-text-muted" data-testid="conversation-output-empty">
          {t('workbench.output_summary_empty', '暂无输出内容')}
        </p>
      )}

      {summary.sources.length > 0 && (
        <section
          className="mt-3 border-t border-border pt-3"
          data-testid="conversation-source-list"
        >
          <h3 className="mb-2 text-xs font-medium text-text-secondary">
            {t('workbench.output_summary_sources', '来源')}
          </h3>
          <div className="space-y-0.5">
            {summary.sources.map(source => {
              const Icon = SOURCE_ICONS[source.kind]
              const content = (
                <>
                  <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate">{source.title}</span>
                </>
              )
              return source.resource ? (
                <button
                  key={source.id}
                  type="button"
                  data-testid={`conversation-source-item-${source.id}`}
                  onClick={() => void services.openResource(source.resource!)}
                  className="flex h-9 w-full min-w-0 items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover"
                  title={source.title}
                >
                  {content}
                </button>
              ) : (
                <div
                  key={source.id}
                  data-testid={`conversation-source-item-${source.id}`}
                  className="flex h-9 w-full min-w-0 items-center gap-3 text-sm text-text-primary"
                  title={source.title}
                >
                  {content}
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
