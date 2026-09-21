'use client'

import { Progress } from '@/components/ui/progress'
import { useShareToken } from '@/contexts/ShareTokenContext'
import { safeCardUrl } from '@/features/cards/VideoDirectorGenerationCard'
import type { CardRendererProps } from '@/features/cards/types'
import { VideoPlayer } from '@/features/tasks/components/message/VideoPlayer'
import { useTranslation } from '@/hooks/useTranslation'
import { OpenCutEditorDialog } from '../materials_to_video/OpenCutEditorDialog'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from './mediaUrls'

interface StyleVideo {
  sub_task_id: string
  title?: string
  theme?: string
  status?: string
  progress?: number
  video_url?: string
  cover_url?: string
  duration?: number
  error?: string
}

export default function MultiStyleVideoCard({ block, onChatButtonClick }: CardRendererProps) {
  const { t } = useTranslation('video')
  const { shareToken } = useShareToken()
  const source = block.card_data?.videos
  const videos: StyleVideo[] = Array.isArray(source)
    ? source.filter((item): item is StyleVideo =>
        Boolean(item && typeof item.sub_task_id === 'string')
      )
    : []
  const terminal = block.card_status === 'populated' || block.card_status === 'error'
  const render = async (item: StyleVideo) => {
    if (!onChatButtonClick || shareToken) return
    await onChatButtonClick(t('multiStyle.renderRequest', { subTaskId: item.sub_task_id }))
  }

  return (
    <section className="w-full space-y-3" data-testid="multi-style-card">
      <div className="text-sm font-medium">{t('multiStyle.title')}</div>
      {!videos.length && !terminal ? (
        <p className="text-sm text-text-muted" data-testid="multi-style-planning">
          {t('multiStyle.planning')}
        </p>
      ) : null}
      {block.card_status === 'error' ? (
        <p className="text-sm text-destructive" role="alert">
          {t('multiStyle.failed')}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {videos.map((item, index) => {
          const url = safeCardUrl(item.video_url)
          const ready = item.status === 'completed' && Boolean(url)
          const failed = item.status === 'failed' || (terminal && !ready)
          return (
            <article
              key={item.sub_task_id}
              className="min-w-0 space-y-2 rounded-lg border border-border p-3"
              data-testid={`multi-style-${item.sub_task_id}`}
            >
              <div className="text-sm font-medium">
                {item.title || item.theme || t('multiStyle.variant', { index: index + 1 })}
              </div>
              {ready && url ? (
                <VideoPlayer
                  videoUrl={getAigcVideoPlaybackUrl(url, shareToken || undefined)}
                  coverUrl={getAigcVideoImageUrl(
                    safeCardUrl(item.cover_url) || undefined,
                    shareToken || undefined
                  )}
                  duration={item.duration}
                  videoTestId={`multi-style-player-${item.sub_task_id}`}
                />
              ) : failed ? (
                <p className="text-sm text-destructive">{t('multiStyle.failed')}</p>
              ) : (
                <div className="space-y-2" data-testid={`multi-style-progress-${item.sub_task_id}`}>
                  <span className="text-sm text-text-muted">{t('multiStyle.processing')}</span>
                  <Progress value={Math.max(0, Math.min(100, Number(item.progress) || 0))} />
                </div>
              )}
              {ready && !shareToken ? (
                <div className="flex flex-wrap gap-2">
                  <OpenCutEditorDialog
                    sessionId={item.sub_task_id}
                    artifactId=""
                    onRender={onChatButtonClick ? () => render(item) : undefined}
                  />
                </div>
              ) : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}
