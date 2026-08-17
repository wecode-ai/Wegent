// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Captions,
  Film,
  Loader2,
  Music2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from '../aigc_video/types'
import type { FinalVideoCover, ScriptBgmItem } from '../script/types'
import type { Storyboard } from '../storyboard/types'
import { compositionApis } from './api'
import type {
  CompositionBgm,
  CompositionClip,
  CompositionSubtitle,
  MusicTaskStatusResponse,
  SubtitleTaskStatusResponse,
} from './types'
import {
  type BgmTaskCache,
  buildClips,
  buildSrt,
  buildSubtitles,
  effectiveDuration,
  loadBgmTasks,
  loadSubtitleTasks,
  parseSrt,
  removeBgmTask,
  removeSubtitleTask,
  saveBgmTask,
  saveSubtitleTask,
  type SubtitleTaskCache,
} from './utils'

interface CompositionEditorProps {
  scriptId: number
  taskId: number
  storyboards: Storyboard[]
  selectedVersionMap: Record<number, number>
  bgm?: ScriptBgmItem[]
  bgmEnabled?: boolean
  subtitleEnabled?: boolean
  finalVideoCover?: FinalVideoCover | null
  onClose: () => void
  onGenerateFinalVideo?: () => void
  onSaved?: () => void
}

interface CompositionSnapshot {
  clips: CompositionClip[]
  subtitles: CompositionSubtitle[]
  bgm: CompositionBgm[]
  bgmEnabled: boolean
  subtitleEnabled: boolean
}

const wait = (milliseconds: number) =>
  new Promise<void>(resolve => window.setTimeout(resolve, milliseconds))

function asBgm(items: ScriptBgmItem[]): CompositionBgm[] {
  return items.map(item => ({
    ...item,
    volume: item.volume ?? 0.15,
    status: item.status ?? (item.audio_url ? 'success' : 'draft'),
  }))
}

export function CompositionEditor({
  scriptId,
  taskId,
  storyboards,
  selectedVersionMap,
  bgm = [],
  bgmEnabled: initialBgmEnabled = true,
  subtitleEnabled: initialSubtitleEnabled = true,
  finalVideoCover,
  onClose,
  onGenerateFinalVideo,
  onSaved,
}: CompositionEditorProps) {
  const { t } = useTranslation('video')
  const { toast } = useToast()
  const initialClips = useMemo(
    () => buildClips(storyboards, selectedVersionMap),
    [selectedVersionMap, storyboards]
  )
  const initialSnapshot = useMemo<CompositionSnapshot>(() => {
    const clips = initialClips
    return {
      clips,
      subtitles: buildSubtitles(storyboards, clips),
      bgm: asBgm(bgm),
      bgmEnabled: initialBgmEnabled,
      subtitleEnabled: initialSubtitleEnabled,
    }
  }, [bgm, initialBgmEnabled, initialClips, initialSubtitleEnabled, storyboards])
  const [clips, setClips] = useState(initialSnapshot.clips)
  const [subtitles, setSubtitles] = useState(initialSnapshot.subtitles)
  const [bgmItems, setBgmItems] = useState(initialSnapshot.bgm)
  const [bgmEnabled, setBgmEnabled] = useState(initialSnapshot.bgmEnabled)
  const [subtitleEnabled, setSubtitleEnabled] = useState(initialSnapshot.subtitleEnabled)
  const [selectedClipId, setSelectedClipId] = useState(initialClips[0]?.clip_id ?? null)
  const [previewClipId, setPreviewClipId] = useState(initialClips[0]?.clip_id ?? null)
  const [saving, setSaving] = useState(false)
  const [generatingMusic, setGeneratingMusic] = useState(false)
  const [musicPrompt, setMusicPrompt] = useState('')
  const [regeneratingSubtitle, setRegeneratingSubtitle] = useState(false)
  const [coverTime, setCoverTime] = useState(finalVideoCover?.cover_time_in_source ?? 0)
  const [savingCover, setSavingCover] = useState(false)
  const initialRef = useRef(JSON.stringify(initialSnapshot))
  const mountedRef = useRef(true)
  const clipsRef = useRef(clips)
  const activeMusicPollsRef = useRef(new Set<string>())
  const activeSubtitlePollsRef = useRef(new Set<string>())

  const currentSnapshot = useMemo(
    () => ({ clips, subtitles, bgm: bgmItems, bgmEnabled, subtitleEnabled }),
    [bgmEnabled, bgmItems, clips, subtitleEnabled, subtitles]
  )
  const dirty = JSON.stringify(currentSnapshot) !== initialRef.current
  const selectedClip = clips.find(clip => clip.clip_id === selectedClipId) ?? clips[0]
  const previewClip = clips.find(clip => clip.clip_id === previewClipId) ?? clips[0]
  const totalDuration = clips
    .filter(clip => clip.enabled)
    .reduce((total, clip) => total + effectiveDuration(clip), 0)
  const generationBusy = generatingMusic || regeneratingSubtitle

  useEffect(() => {
    if (!selectedClipId && clips[0]) setSelectedClipId(clips[0].clip_id)
    if (!previewClipId && clips[0]) setPreviewClipId(clips[0].clip_id)
  }, [clips, previewClipId, selectedClipId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    clipsRef.current = clips
  }, [clips])

  const updateClip = (clipId: number, update: Partial<CompositionClip>) => {
    setClips(current =>
      current.map(clip => (clip.clip_id === clipId ? { ...clip, ...update } : clip))
    )
  }

  const moveClip = (clipId: number, direction: -1 | 1) => {
    setClips(current => {
      const index = current.findIndex(clip => clip.clip_id === clipId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)
      return next.map((clip, order) => ({ ...clip, order }))
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const response = await compositionApis.saveComposition({
        script_id: scriptId,
        task_id: taskId,
        clips: clips.map(clip => ({
          storyboard_id: clip.storyboard_id,
          clip_id: clip.clip_id,
          trim_start: clip.trim_start,
          trim_end: clip.trim_end,
          enabled: clip.enabled,
          volume: clip.volume,
          srt_text: buildSrt(
            subtitles.filter(subtitle => subtitle.storyboard_id === clip.storyboard_id)
          ),
        })),
        bgm: bgmItems.map(item => ({
          idx: item.idx,
          start_time: item.start_time,
          end_time: item.end_time,
          audio_url: item.audio_url,
          media_id: item.media_id,
          volume: item.volume,
          prompt: item.prompt,
          mood: item.mood,
          style: item.style,
        })),
        subtitles_enabled: subtitleEnabled,
        bgm_enabled: bgmEnabled,
      })
      initialRef.current = JSON.stringify(currentSnapshot)
      toast({ description: response.message || t('composition.saveSuccess') })
      onSaved?.()
      return true
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('composition.saveFailed'),
      })
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveAndGenerate = async () => {
    if (!(await save())) return
    onGenerateFinalVideo?.()
  }

  const handleClose = () => {
    if (dirty && !window.confirm(t('composition.discardConfirm'))) return
    onClose()
  }

  const handlePreviewEnded = () => {
    if (!previewClip) return
    const enabled = clips.filter(clip => clip.enabled)
    const index = enabled.findIndex(clip => clip.clip_id === previewClip.clip_id)
    const next = enabled[index + 1]
    if (next) setPreviewClipId(next.clip_id)
  }

  const pollMusicTask = useCallback(
    async (task: BgmTaskCache) => {
      if (activeMusicPollsRef.current.has(task.task_uuid)) return
      activeMusicPollsRef.current.add(task.task_uuid)
      setGeneratingMusic(true)
      try {
        for (;;) {
          if (!mountedRef.current) return
          let status: MusicTaskStatusResponse
          try {
            status = await compositionApis.getMusicTaskStatus(task.task_uuid)
          } catch {
            await wait(5000)
            continue
          }
          if (!mountedRef.current) return
          const state = status.status ?? status.wb_data?.status
          if (state === 'failed') {
            removeBgmTask(scriptId, task.idx)
            throw new Error(status.error || status.wb_data?.error_message || '')
          }
          if (state === 'completed') {
            const mediaId = status.result?.media_id || status.wb_data?.media_id || ''
            const audioUrl = status.result?.audio_url || status.wb_data?.audio_url || ''
            if (!mediaId || !audioUrl) {
              removeBgmTask(scriptId, task.idx)
              throw new Error(t('composition.musicFailed'))
            }
            setBgmItems(current => {
              const generated: CompositionBgm = {
                idx: task.idx,
                start_time: 0,
                end_time: task.duration,
                mood: '',
                style: '',
                prompt: task.prompt,
                status: 'success',
                audio_url: audioUrl,
                media_id: mediaId,
                volume: 0.15,
              }
              return current.some(item => item.idx === task.idx)
                ? current.map(item => (item.idx === task.idx ? generated : item))
                : [...current, generated]
            })
            setBgmEnabled(true)
            removeBgmTask(scriptId, task.idx)
            return
          }
          await wait(2500)
        }
      } catch (error) {
        if (mountedRef.current) {
          setBgmItems(current => current.filter(item => item.idx !== task.idx))
          toast({
            variant: 'destructive',
            description:
              error instanceof Error && error.message
                ? error.message
                : t('composition.musicFailed'),
          })
        }
      } finally {
        activeMusicPollsRef.current.delete(task.task_uuid)
        if (mountedRef.current) {
          setGeneratingMusic(activeMusicPollsRef.current.size > 0)
        }
      }
    },
    [scriptId, t, toast]
  )

  const generateMusic = async () => {
    const prompt = musicPrompt.trim()
    if (!prompt) return
    setGeneratingMusic(true)
    try {
      const duration = Math.max(Math.ceil(totalDuration), 1)
      const response = await compositionApis.generateMusic({ prompt, duration })
      const task: BgmTaskCache = {
        task_uuid: response.task_uuid,
        idx: Math.max(-1, ...bgmItems.map(item => item.idx)) + 1,
        prompt,
        duration,
      }
      setBgmItems(current => [
        ...current,
        {
          idx: task.idx,
          start_time: 0,
          end_time: duration,
          mood: '',
          style: '',
          prompt,
          status: 'pending',
          audio_url: '',
          media_id: '',
          volume: 0.15,
          task_uuid: task.task_uuid,
        },
      ])
      setMusicPrompt('')
      saveBgmTask(scriptId, task)
      void pollMusicTask(task)
    } catch (error) {
      setGeneratingMusic(false)
      toast({
        variant: 'destructive',
        description:
          error instanceof Error && error.message ? error.message : t('composition.musicFailed'),
      })
    }
  }

  const pollSubtitleTask = useCallback(
    async (task: SubtitleTaskCache) => {
      if (activeSubtitlePollsRef.current.has(task.task_uuid)) return
      activeSubtitlePollsRef.current.add(task.task_uuid)
      setRegeneratingSubtitle(true)
      try {
        for (;;) {
          if (!mountedRef.current) return
          let status: SubtitleTaskStatusResponse
          try {
            status = await compositionApis.getSubtitleTaskStatus(task.task_uuid)
          } catch {
            await wait(5000)
            continue
          }
          if (!mountedRef.current) return
          if (status.status === 'failed') {
            removeSubtitleTask(scriptId, task.storyboard_id)
            throw new Error(status.error || '')
          }
          if (status.status === 'completed') {
            if (!status.result) {
              removeSubtitleTask(scriptId, task.storyboard_id)
              throw new Error(t('composition.subtitleFailed'))
            }
            const currentClips = clipsRef.current
            const clipIndex = currentClips.findIndex(clip => clip.clip_id === task.clip_id)
            if (clipIndex >= 0) {
              const offset = currentClips
                .slice(0, clipIndex)
                .filter(clip => clip.enabled)
                .reduce((total, clip) => total + effectiveDuration(clip), 0)
              const regenerated = parseSrt(status.result.srt_content, task.storyboard_id, offset)
              setSubtitles(current => [
                ...current.filter(item => item.storyboard_id !== task.storyboard_id),
                ...regenerated,
              ])
            }
            removeSubtitleTask(scriptId, task.storyboard_id)
            return
          }
          await wait(2500)
        }
      } catch (error) {
        if (mountedRef.current) {
          toast({
            variant: 'destructive',
            description:
              error instanceof Error && error.message
                ? error.message
                : t('composition.subtitleFailed'),
          })
        }
      } finally {
        activeSubtitlePollsRef.current.delete(task.task_uuid)
        if (mountedRef.current) {
          setRegeneratingSubtitle(activeSubtitlePollsRef.current.size > 0)
        }
      }
    },
    [scriptId, t, toast]
  )

  const regenerateSubtitles = async () => {
    if (!selectedClip) return
    setRegeneratingSubtitle(true)
    try {
      const response = await compositionApis.regenerateSubtitles({
        clip_id: selectedClip.clip_id,
        script_id: scriptId,
        trim_start: selectedClip.trim_start,
        trim_end: selectedClip.trim_end,
        save_to_db: false,
      })
      const task: SubtitleTaskCache = {
        task_uuid: response.task_uuid,
        storyboard_id: selectedClip.storyboard_id,
        clip_id: selectedClip.clip_id,
      }
      saveSubtitleTask(scriptId, task)
      void pollSubtitleTask(task)
    } catch (error) {
      setRegeneratingSubtitle(false)
      toast({
        variant: 'destructive',
        description:
          error instanceof Error && error.message ? error.message : t('composition.subtitleFailed'),
      })
    }
  }

  useEffect(() => {
    const tasks = loadBgmTasks(scriptId)
    if (tasks.length === 0) return
    setBgmItems(current => {
      const next = [...current]
      for (const task of tasks) {
        if (next.some(item => item.idx === task.idx)) continue
        next.push({
          idx: task.idx,
          start_time: 0,
          end_time: task.duration,
          mood: '',
          style: '',
          prompt: task.prompt,
          status: 'pending',
          audio_url: '',
          media_id: '',
          volume: 0.15,
          task_uuid: task.task_uuid,
        })
      }
      return next
    })
    for (const task of tasks) void pollMusicTask(task)
  }, [pollMusicTask, scriptId])

  useEffect(() => {
    const tasks = loadSubtitleTasks(scriptId)
    for (const task of tasks) void pollSubtitleTask(task)
  }, [pollSubtitleTask, scriptId])

  const addSubtitle = () => {
    if (!selectedClip) return
    const localEnd = Math.min(2, effectiveDuration(selectedClip))
    setSubtitles(current => [
      ...current,
      {
        id: `${selectedClip.storyboard_id}-${Date.now()}`,
        storyboard_id: selectedClip.storyboard_id,
        start: 0,
        end: localEnd,
        clip_local_start: 0,
        clip_local_end: localEnd,
        text: '',
        enabled: true,
      },
    ])
  }

  const setFinalCover = async () => {
    if (!selectedClip) return
    setSavingCover(true)
    try {
      const response = await compositionApis.updateFinalCover(
        scriptId,
        selectedClip.clip_id,
        coverTime
      )
      toast({ description: response.message })
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('composition.coverFailed'),
      })
    } finally {
      setSavingCover(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base" data-testid="video-composition-editor">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <Button
          variant="ghost"
          onClick={handleClose}
          data-testid="video-composition-back"
          className="min-h-11"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('composition.back')}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!dirty || saving || generationBusy}
            onClick={() => void save()}
            data-testid="video-composition-save"
            className="min-h-11"
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t('composition.save')}
          </Button>
          {onGenerateFinalVideo ? (
            <Button
              disabled={saving || generationBusy}
              onClick={() => void saveAndGenerate()}
              data-testid="video-composition-generate-final"
              className="min-h-11"
            >
              <Film className="mr-2 h-4 w-4" />
              {t('composition.generate')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_400px] lg:overflow-hidden">
        <section className="flex min-h-[420px] min-w-0 flex-col border-b border-border lg:min-h-0 lg:border-b-0 lg:border-r">
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
            {previewClip ? (
              <video
                key={previewClip.clip_id}
                controls
                autoPlay
                className="max-h-full max-w-full rounded-lg"
                src={getAigcVideoPlaybackUrl(previewClip.video_url)}
                poster={getAigcVideoImageUrl(previewClip.cover_url)}
                onLoadedMetadata={event => {
                  event.currentTarget.currentTime = previewClip.trim_start
                }}
                onTimeUpdate={event => {
                  if (
                    previewClip.trim_end != null &&
                    event.currentTarget.currentTime >= previewClip.trim_end
                  ) {
                    event.currentTarget.pause()
                    handlePreviewEnded()
                  }
                }}
                onEnded={handlePreviewEnded}
                data-testid="video-composition-preview"
              />
            ) : (
              <div className="text-sm text-white/60">{t('composition.noClips')}</div>
            )}
          </div>
          <div className="shrink-0 space-y-2 overflow-x-auto border-t border-border bg-surface p-3">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span>{t('composition.timeline')}</span>
              <span>{totalDuration.toFixed(1)}s</span>
            </div>
            <div className="flex min-w-max gap-2">
              {clips.map((clip, index) => (
                <button
                  key={clip.clip_id}
                  type="button"
                  onClick={() => {
                    setSelectedClipId(clip.clip_id)
                    setPreviewClipId(clip.clip_id)
                  }}
                  className={`relative h-24 w-36 overflow-hidden rounded-lg border-2 text-left ${
                    selectedClip?.clip_id === clip.clip_id ? 'border-primary' : 'border-transparent'
                  } ${clip.enabled ? '' : 'opacity-40'}`}
                  data-testid={`video-composition-clip-${clip.clip_id}`}
                >
                  {clip.cover_url ? (
                    <img
                      src={getAigcVideoImageUrl(clip.cover_url)}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-muted" />
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1 text-xs text-white">
                    {index + 1}. {clip.title} · {effectiveDuration(clip).toFixed(1)}s
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto bg-surface p-4">
          <Tabs defaultValue="clip">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="clip" data-testid="video-composition-tab-clip">
                {t('composition.clip')}
              </TabsTrigger>
              <TabsTrigger value="subtitle" data-testid="video-composition-tab-subtitle">
                {t('composition.subtitle')}
              </TabsTrigger>
              <TabsTrigger value="music" data-testid="video-composition-tab-music">
                {t('composition.music')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="clip" className="space-y-6 pt-4">
              {selectedClip ? (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{selectedClip.title}</div>
                      <div className="text-xs text-text-secondary">
                        {selectedClip.source_duration.toFixed(1)}s
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={clips[0]?.clip_id === selectedClip.clip_id}
                        onClick={() => moveClip(selectedClip.clip_id, -1)}
                        data-testid="video-composition-move-up"
                        aria-label={t('composition.moveEarlier')}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={clips.at(-1)?.clip_id === selectedClip.clip_id}
                        onClick={() => moveClip(selectedClip.clip_id, 1)}
                        data-testid="video-composition-move-down"
                        aria-label={t('composition.moveLater')}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="composition-clip-enabled">{t('composition.enabled')}</Label>
                    <Switch
                      id="composition-clip-enabled"
                      checked={selectedClip.enabled}
                      onCheckedChange={enabled => updateClip(selectedClip.clip_id, { enabled })}
                      data-testid="video-composition-clip-enabled"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="composition-trim-start">{t('composition.trimStart')}</Label>
                      <Input
                        id="composition-trim-start"
                        type="number"
                        min={0}
                        max={selectedClip.trim_end ?? selectedClip.source_duration}
                        step={0.1}
                        value={selectedClip.trim_start}
                        onChange={event =>
                          updateClip(selectedClip.clip_id, {
                            trim_start: Math.min(
                              Math.max(Number(event.target.value), 0),
                              selectedClip.trim_end ?? selectedClip.source_duration
                            ),
                          })
                        }
                        data-testid="video-composition-trim-start"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="composition-trim-end">{t('composition.trimEnd')}</Label>
                      <Input
                        id="composition-trim-end"
                        type="number"
                        min={selectedClip.trim_start}
                        max={selectedClip.source_duration}
                        step={0.1}
                        value={selectedClip.trim_end ?? selectedClip.source_duration}
                        onChange={event =>
                          updateClip(selectedClip.clip_id, {
                            trim_end: Math.max(
                              selectedClip.trim_start,
                              Math.min(Number(event.target.value), selectedClip.source_duration)
                            ),
                          })
                        }
                        data-testid="video-composition-trim-end"
                      />
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <Label>{t('composition.clipVolume')}</Label>
                      <span>{Math.round(selectedClip.volume * 100)}%</span>
                    </div>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={[selectedClip.volume]}
                      onValueChange={value =>
                        updateClip(selectedClip.clip_id, { volume: value[0] })
                      }
                      data-testid="video-composition-clip-volume"
                    />
                  </div>
                  <div className="space-y-2 border-t border-border pt-5">
                    <Label htmlFor="composition-cover-time">{t('composition.cover')}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="composition-cover-time"
                        type="number"
                        min={selectedClip.trim_start}
                        max={selectedClip.trim_end ?? selectedClip.source_duration}
                        step={0.1}
                        value={coverTime}
                        onChange={event => setCoverTime(Number(event.target.value))}
                        data-testid="video-composition-cover-time"
                      />
                      <Button
                        variant="outline"
                        disabled={savingCover}
                        onClick={() => void setFinalCover()}
                        data-testid="video-composition-set-cover"
                      >
                        {savingCover ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          t('composition.setCover')
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </TabsContent>

            <TabsContent value="subtitle" className="space-y-4 pt-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="composition-subtitle-enabled">
                  {t('composition.subtitleEnabled')}
                </Label>
                <Switch
                  id="composition-subtitle-enabled"
                  checked={subtitleEnabled}
                  onCheckedChange={setSubtitleEnabled}
                  data-testid="video-composition-subtitle-enabled"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={addSubtitle}
                  disabled={!selectedClip}
                  data-testid="video-composition-add-subtitle"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t('composition.addSubtitle')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void regenerateSubtitles()}
                  disabled={!selectedClip || regeneratingSubtitle}
                  data-testid="video-composition-regenerate-subtitle"
                >
                  {regeneratingSubtitle ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Captions className="mr-2 h-4 w-4" />
                  )}
                  {t('composition.regenerateSubtitle')}
                </Button>
              </div>
              {selectedClip
                ? subtitles
                    .filter(subtitle => subtitle.storyboard_id === selectedClip.storyboard_id)
                    .map(subtitle => (
                      <div
                        key={subtitle.id}
                        className="space-y-2 rounded-lg border border-border p-3"
                      >
                        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                          <Input
                            type="number"
                            min={0}
                            step={0.1}
                            value={subtitle.clip_local_start}
                            aria-label={t('composition.subtitleStart')}
                            onChange={event => {
                              const value = Number(event.target.value)
                              setSubtitles(current =>
                                current.map(item =>
                                  item.id === subtitle.id
                                    ? { ...item, clip_local_start: value }
                                    : item
                                )
                              )
                            }}
                            data-testid={`video-subtitle-start-${subtitle.id}`}
                          />
                          <Input
                            type="number"
                            min={subtitle.clip_local_start}
                            step={0.1}
                            value={subtitle.clip_local_end}
                            aria-label={t('composition.subtitleEnd')}
                            onChange={event => {
                              const value = Number(event.target.value)
                              setSubtitles(current =>
                                current.map(item =>
                                  item.id === subtitle.id
                                    ? { ...item, clip_local_end: value }
                                    : item
                                )
                              )
                            }}
                            data-testid={`video-subtitle-end-${subtitle.id}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              setSubtitles(current =>
                                current.filter(item => item.id !== subtitle.id)
                              )
                            }
                            data-testid={`video-subtitle-delete-${subtitle.id}`}
                            aria-label={t('composition.deleteSubtitle')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        <Textarea
                          value={subtitle.text}
                          onChange={event =>
                            setSubtitles(current =>
                              current.map(item =>
                                item.id === subtitle.id
                                  ? { ...item, text: event.target.value }
                                  : item
                              )
                            )
                          }
                          data-testid={`video-subtitle-text-${subtitle.id}`}
                        />
                      </div>
                    ))
                : null}
            </TabsContent>

            <TabsContent value="music" className="space-y-4 pt-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="composition-bgm-enabled">{t('composition.musicEnabled')}</Label>
                <Switch
                  id="composition-bgm-enabled"
                  checked={bgmEnabled}
                  onCheckedChange={setBgmEnabled}
                  data-testid="video-composition-music-enabled"
                />
              </div>
              <Textarea
                value={musicPrompt}
                onChange={event => setMusicPrompt(event.target.value)}
                placeholder={t('composition.musicPrompt')}
                data-testid="video-composition-music-prompt"
              />
              <Button
                onClick={() => void generateMusic()}
                disabled={!musicPrompt.trim() || generatingMusic}
                data-testid="video-composition-generate-music"
              >
                {generatingMusic ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Music2 className="mr-2 h-4 w-4" />
                )}
                {t('composition.generateMusic')}
              </Button>
              {bgmItems.map(item => (
                <div key={item.idx} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      {item.status === 'pending' ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                      ) : null}
                      <span>{item.prompt || t('composition.music')}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={item.status === 'pending'}
                      onClick={() => {
                        removeBgmTask(scriptId, item.idx)
                        setBgmItems(current => current.filter(bgmItem => bgmItem.idx !== item.idx))
                      }}
                      data-testid={`video-music-delete-${item.idx}`}
                      aria-label={t('composition.deleteMusic')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {item.audio_url ? (
                    <audio controls src={item.audio_url} className="w-full" />
                  ) : null}
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>{t('composition.musicVolume')}</span>
                    <span>{Math.round(item.volume * 100)}%</span>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.01}
                    value={[item.volume]}
                    onValueChange={value =>
                      setBgmItems(current =>
                        current.map(bgmItem =>
                          bgmItem.idx === item.idx ? { ...bgmItem, volume: value[0] } : bgmItem
                        )
                      )
                    }
                    data-testid={`video-music-volume-${item.idx}`}
                  />
                </div>
              ))}
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  )
}
