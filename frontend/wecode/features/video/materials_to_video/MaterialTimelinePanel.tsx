// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Film, Loader2, Music, Save, Subtitles } from 'lucide-react'
import Image from 'next/image'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from '../aigc_video/mediaUrls'
import { materialTimelineApi } from './api'
import { OpenCutEditorDialog } from './OpenCutEditorDialog'
import type { MaterialTimelineRecord, MaterialTimelineTracks, TimelineTrack } from './types'
import { milliseconds, timelineTracks, updateTrack } from './utils'

interface MaterialTimelinePanelProps {
  sessionId: string
  onContinue?: (buttonName?: string) => void
  autoOpenOpenCut?: boolean
  onOpenCutClose?: () => void
}

type TimelineTab = 'video' | 'subtitles' | 'music'

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function windowValue(track: TimelineTrack, windowName: string, key: string): number {
  const window = track[windowName]
  return window && typeof window === 'object'
    ? milliseconds((window as Record<string, unknown>)[key]) / 1000
    : 0
}

function updateWindow(
  track: TimelineTrack,
  windowName: string,
  key: 'start' | 'end',
  seconds: number
): TimelineTrack {
  const current = track[windowName]
  const nextWindow: Record<string, unknown> =
    current && typeof current === 'object' ? { ...current } : {}
  nextWindow[key] = Math.round(Math.max(0, seconds) * 1000)
  if (typeof nextWindow.start === 'number' && typeof nextWindow.end === 'number') {
    nextWindow.duration = Math.max(0, nextWindow.end - nextWindow.start)
  }
  return updateTrack(track, windowName, nextWindow)
}

function trackSource(track: TimelineTrack): string {
  return (
    ['source_path', 'path', 'url']
      .map(key => track[key])
      .find((value): value is string => typeof value === 'string' && value.length > 0) || ''
  )
}

export function MaterialTimelinePanel({
  sessionId,
  onContinue,
  autoOpenOpenCut,
  onOpenCutClose,
}: MaterialTimelinePanelProps) {
  const { t } = useTranslation('video')
  const { toast } = useToast()
  const [record, setRecord] = useState<MaterialTimelineRecord | null>(null)
  const [tracks, setTracks] = useState<MaterialTimelineTracks | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<TimelineTab>('video')

  const load = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true)
      try {
        const response = await materialTimelineApi.get(sessionId)
        const active = response.tracks[0]
        setRecord(active ?? null)
        setTracks(active ? timelineTracks(active) : null)
      } catch (error) {
        toast({
          variant: 'destructive',
          description:
            error instanceof Error ? error.message : t('materialEditor.timeline.loadFailed'),
        })
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [sessionId, t, toast]
  )

  useEffect(() => {
    void load()
  }, [load])

  const save = async (renderAfterSave: boolean) => {
    if (!record || !tracks) return
    setSaving(true)
    try {
      await materialTimelineApi.update(sessionId, record.task_id, tracks)
      toast({ description: t('materialEditor.timeline.saved') })
      if (renderAfterSave) onContinue?.(t('materialEditor.timeline.render'))
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error ? error.message : t('materialEditor.timeline.saveFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  const updateList = (
    key: keyof MaterialTimelineTracks,
    index: number,
    updater: (track: TimelineTrack) => TimelineTrack
  ) => {
    setTracks(current => {
      if (!current) return current
      const next = [...current[key]]
      next[index] = updater(next[index])
      return { ...current, [key]: next }
    })
  }

  if (loading) {
    return (
      <div
        className="flex min-h-48 items-center justify-center"
        data-testid="material-timeline-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    )
  }

  if (!record || !tracks) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-text-secondary">
        <span>{t('materialEditor.timeline.empty')}</span>
        <Button variant="outline" onClick={() => void load()} data-testid="material-timeline-retry">
          {t('materialEditor.retry')}
        </Button>
      </div>
    )
  }

  const tabs: Array<{ key: TimelineTab; label: string; count: number; icon: typeof Film }> = [
    {
      key: 'video',
      label: t('materialEditor.timeline.video'),
      count: tracks.video.length,
      icon: Film,
    },
    {
      key: 'subtitles',
      label: t('materialEditor.timeline.subtitles'),
      count: tracks.subtitles.length,
      icon: Subtitles,
    },
    {
      key: 'music',
      label: t('materialEditor.timeline.music'),
      count: tracks.bgm.length,
      icon: Music,
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="material-timeline-panel">
      <nav className="flex shrink-0 gap-2 border-b border-border px-5 py-3">
        {tabs.map(item => {
          const Icon = item.icon
          return (
            <Button
              key={item.key}
              variant={tab === item.key ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setTab(item.key)}
              data-testid={`material-timeline-tab-${item.key}`}
            >
              <Icon className="mr-2 h-4 w-4" />
              {item.label} ({item.count})
            </Button>
          )
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-5">
        {tab === 'video' ? (
          <div className="space-y-4">
            {tracks.video.map((track, index) => {
              const source = trackSource(track)
              const kind = stringValue(track.kind) || 'video'
              return (
                <section
                  key={stringValue(track.clip_id) || index}
                  className="grid gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-[200px_1fr]"
                  data-testid={`material-timeline-video-${index}`}
                >
                  <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-black">
                    {source && kind === 'video' ? (
                      <video
                        src={getAigcVideoPlaybackUrl(source)}
                        controls
                        preload="metadata"
                        className="h-full w-full object-contain"
                      />
                    ) : source ? (
                      <Image
                        src={getAigcVideoImageUrl(source) || source}
                        alt=""
                        fill
                        unoptimized
                        sizes="200px"
                        className="object-contain"
                      />
                    ) : (
                      <Film className="h-8 w-8 text-white/60" />
                    )}
                  </div>
                  <div className="grid content-start gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2 text-sm font-medium">
                      {t('materialEditor.timeline.clip', { index: index + 1 })}
                    </div>
                    <div>
                      <Label>{t('materialEditor.timeline.trimStart')}</Label>
                      <Input
                        type="number"
                        min={0}
                        step={0.1}
                        value={windowValue(track, 'source_window', 'start')}
                        onChange={event =>
                          updateList('video', index, current =>
                            updateWindow(
                              current,
                              'source_window',
                              'start',
                              Number(event.target.value)
                            )
                          )
                        }
                        data-testid={`material-timeline-trim-start-${index}`}
                      />
                    </div>
                    <div>
                      <Label>{t('materialEditor.timeline.trimEnd')}</Label>
                      <Input
                        type="number"
                        min={0}
                        step={0.1}
                        value={windowValue(track, 'source_window', 'end')}
                        onChange={event =>
                          updateList('video', index, current =>
                            updateWindow(
                              current,
                              'source_window',
                              'end',
                              Number(event.target.value)
                            )
                          )
                        }
                        data-testid={`material-timeline-trim-end-${index}`}
                      />
                    </div>
                    <div>
                      <Label>{t('materialEditor.timeline.speed')}</Label>
                      <Input
                        type="number"
                        min={0.1}
                        max={8}
                        step={0.1}
                        value={Number(track.playback_rate) || 1}
                        onChange={event =>
                          updateList('video', index, current =>
                            updateTrack(current, 'playback_rate', Number(event.target.value))
                          )
                        }
                        data-testid={`material-timeline-speed-${index}`}
                      />
                    </div>
                    {kind === 'video' ? (
                      <label className="flex items-end gap-2 pb-2 text-sm">
                        <input
                          type="checkbox"
                          checked={booleanValue(track.keep_audio)}
                          onChange={event =>
                            updateList('video', index, current =>
                              updateTrack(current, 'keep_audio', event.target.checked)
                            )
                          }
                          className="h-4 w-4 accent-primary"
                          data-testid={`material-timeline-keep-audio-${index}`}
                        />
                        {t('materialEditor.timeline.keepAudio')}
                      </label>
                    ) : null}
                  </div>
                </section>
              )
            })}
          </div>
        ) : null}

        {tab === 'subtitles' ? (
          <div className="space-y-3">
            {tracks.subtitles.map((track, index) => (
              <section
                key={stringValue(track.unit_id) || index}
                className="rounded-lg border border-border bg-surface p-4"
                data-testid={`material-timeline-subtitle-${index}`}
              >
                <Label>{t('materialEditor.timeline.subtitle', { index: index + 1 })}</Label>
                <Textarea
                  value={stringValue(track.text)}
                  onChange={event =>
                    updateList('subtitles', index, current =>
                      updateTrack(current, 'text', event.target.value)
                    )
                  }
                  className="mt-2 min-h-20"
                  data-testid={`material-timeline-subtitle-text-${index}`}
                />
                <div className="mt-2 text-xs text-text-secondary">
                  {windowValue(track, 'timeline_window', 'start').toFixed(1)}s –{' '}
                  {windowValue(track, 'timeline_window', 'end').toFixed(1)}s
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {tab === 'music' ? (
          <div className="space-y-3">
            {tracks.bgm.map((track, index) => (
              <section
                key={stringValue(track.media_id) || index}
                className="rounded-lg border border-border bg-surface p-4"
                data-testid={`material-timeline-music-${index}`}
              >
                <Label>{t('materialEditor.timeline.musicPrompt', { index: index + 1 })}</Label>
                <Input
                  value={stringValue(track.prompt)}
                  onChange={event =>
                    updateList('bgm', index, current =>
                      updateTrack(current, 'prompt', event.target.value)
                    )
                  }
                  className="mt-2"
                  data-testid={`material-timeline-music-prompt-${index}`}
                />
                {trackSource(track) ? (
                  <audio
                    src={getAigcVideoPlaybackUrl(trackSource(track))}
                    controls
                    preload="metadata"
                    className="mt-3 w-full"
                  />
                ) : null}
              </section>
            ))}
          </div>
        ) : null}

        {(tab === 'music' ? tracks.bgm : tracks[tab]).length === 0 ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-text-secondary">
            {t('materialEditor.timeline.noTracks')}
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
        <OpenCutEditorDialog
          sessionId={sessionId}
          artifactId={record.task_id}
          onSaved={() => void load(false)}
          autoOpen={autoOpenOpenCut}
          onDialogClose={autoOpenOpenCut ? onOpenCutClose : undefined}
        />
        <Button
          variant="outline"
          onClick={() => void save(false)}
          disabled={saving}
          data-testid="material-timeline-save"
        >
          <Save className="mr-2 h-4 w-4" />
          {t('materialEditor.save')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void save(true)}
          disabled={saving}
          data-testid="material-timeline-save-render"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('materialEditor.timeline.saveAndRender')}
        </Button>
      </footer>
    </div>
  )
}
