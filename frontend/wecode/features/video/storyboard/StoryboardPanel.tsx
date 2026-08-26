// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ImageUp,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from '../aigc_video/mediaUrls'
import { CompositionEditor } from '../composition/CompositionEditor'
import type { CompositionBgm } from '../composition/types'
import { scriptApi } from '../script/api'
import type { FinalVideoCover } from '../script/types'
import { storyboardApis } from './api'
import type {
  GenerateAllVideosParams,
  GenerateSingleVideoParams,
  Storyboard,
  StoryboardUpdateData,
  StoryboardVideoVersion,
  TaskStatusResponse,
  VideoClip,
  VideoGenerateResponse,
} from './types'

interface StoryboardPanelProps {
  scriptId: number
  taskId: number
  initialIndex?: number
  onClose: () => void
  onGenerateFinalVideo?: () => void
}

interface ScriptState {
  title: string
  bgm: CompositionBgm[]
  bgmEnabled: boolean
  subtitleEnabled: boolean
  finalVideoCover: FinalVideoCover | null
}

type GenerationType = 'single' | 'all'

const wait = (milliseconds: number) =>
  new Promise<void>(resolve => window.setTimeout(resolve, milliseconds))

function selectedVersion(storyboard: Storyboard, clipId?: number): StoryboardVideoVersion | null {
  const versions = storyboard.video_versions ?? []
  return (
    versions.find(version => version.id === clipId) ??
    versions.find(version => version.id === storyboard.selected_video_clip_id) ??
    versions.find(version => version.is_selected) ??
    versions[0] ??
    null
  )
}

function effectiveVideo(
  storyboard: Storyboard,
  clipId?: number
): StoryboardVideoVersion | VideoClip | null {
  return selectedVersion(storyboard, clipId) ?? storyboard.video_clip
}

function isGenerating(video: StoryboardVideoVersion | VideoClip | null) {
  return video?.generation_status === 1 || video?.generation_status === 2
}

export function StoryboardPanel({
  scriptId,
  taskId,
  initialIndex = 0,
  onClose,
  onGenerateFinalVideo,
}: StoryboardPanelProps) {
  const { t } = useTranslation('video')
  const { toast } = useToast()
  const [storyboards, setStoryboards] = useState<Storyboard[]>([])
  const [scriptState, setScriptState] = useState<ScriptState>({
    title: '',
    bgm: [],
    bgmEnabled: true,
    subtitleEnabled: true,
    finalVideoCover: null,
  })
  const [ratio, setRatio] = useState<string>()
  const [currentIndex, setCurrentIndex] = useState(Math.max(initialIndex, 0))
  const [selectedVersions, setSelectedVersions] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<StoryboardUpdateData>({})
  const [saving, setSaving] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<number>>(() => new Set())
  const [progress, setProgress] = useState(0)
  const [compositionOpen, setCompositionOpen] = useState(false)
  const [replacingImage, setReplacingImage] = useState(false)
  const [replacingVideo, setReplacingVideo] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const activePollsRef = useRef(new Set<string>())
  const mountedRef = useRef(true)

  const current = storyboards[currentIndex]
  const currentVersion = current ? selectedVersion(current, selectedVersions[current.id]) : null
  const currentVideo = current ? effectiveVideo(current, selectedVersions[current.id]) : null
  const currentBusy = Boolean(current && (busyIds.has(current.id) || isGenerating(currentVideo)))
  const hasReadyVideos = storyboards.some(storyboard => {
    const video = effectiveVideo(storyboard, selectedVersions[storyboard.id])
    return video?.generation_status === 3 && Boolean(video.model_video_url)
  })

  const loadData = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true)
      else setLoading(true)
      try {
        const [storyboardResponse, scriptResponse] = await Promise.all([
          storyboardApis.getStoryboards(scriptId),
          scriptApi.getScript(scriptId),
        ])
        if (!mountedRef.current) return
        setStoryboards(storyboardResponse.storyboards)
        setRatio(storyboardResponse.ratio)
        setSelectedVersions(currentSelections => {
          const next = { ...currentSelections }
          for (const storyboard of storyboardResponse.storyboards) {
            const version = selectedVersion(storyboard, next[storyboard.id])
            if (version) next[storyboard.id] = version.id
          }
          return next
        })
        setScriptState({
          title: scriptResponse.title,
          bgm: (scriptResponse.bgm ?? []).map(item => ({
            ...item,
            volume: item.volume ?? 0.15,
          })),
          bgmEnabled: scriptResponse.global_style?.bgm_enabled ?? true,
          subtitleEnabled: scriptResponse.global_style?.subtitle_enabled ?? true,
          finalVideoCover: scriptResponse.final_video_cover ?? null,
        })
        setCurrentIndex(index =>
          Math.min(index, Math.max(storyboardResponse.storyboards.length - 1, 0))
        )
      } catch (error) {
        toast({
          variant: 'destructive',
          description: error instanceof Error ? error.message : t('storyboard.loadFailed'),
        })
      } finally {
        if (mountedRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [scriptId, t, toast]
  )

  const pollVideo = useCallback(
    async (taskUuid: string, storyboardId?: number, shotId?: string) => {
      const pollKey = `video:${taskUuid}`
      if (activePollsRef.current.has(pollKey)) return
      activePollsRef.current.add(pollKey)
      if (storyboardId) setBusyIds(currentIds => new Set(currentIds).add(storyboardId))
      try {
        for (;;) {
          if (!mountedRef.current) return
          let status: TaskStatusResponse
          try {
            status = await storyboardApis.getVideoTaskStatus(taskUuid, shotId)
          } catch {
            await wait(5000)
            continue
          }
          if (!mountedRef.current) return
          setProgress(status.progress?.percentage ?? 0)
          if (status.status === 'completed') {
            toast({ description: t('storyboard.generateSuccess') })
            break
          }
          if (status.status === 'failed') throw new Error(status.error || '')
          await wait(2500)
        }
      } catch (error) {
        if (mountedRef.current) {
          toast({
            variant: 'destructive',
            description:
              error instanceof Error && error.message
                ? error.message
                : t('storyboard.generateFailed'),
          })
        }
      } finally {
        activePollsRef.current.delete(pollKey)
        if (mountedRef.current) {
          if (storyboardId) {
            setBusyIds(currentIds => {
              const next = new Set(currentIds)
              next.delete(storyboardId)
              return next
            })
          }
          setProgress(0)
          await loadData(true)
        }
      }
    },
    [loadData, t, toast]
  )

  const pollImage = useCallback(
    async (taskUuid: string, storyboardId: number) => {
      const pollKey = `image:${taskUuid}`
      if (activePollsRef.current.has(pollKey)) return
      activePollsRef.current.add(pollKey)
      setBusyIds(currentIds => new Set(currentIds).add(storyboardId))
      try {
        for (;;) {
          if (!mountedRef.current) return
          let status: TaskStatusResponse
          try {
            status = await storyboardApis.getImageTaskStatus(taskUuid)
          } catch {
            await wait(5000)
            continue
          }
          if (!mountedRef.current) return
          setProgress(status.progress?.percentage ?? 0)
          if (status.status === 'completed') {
            toast({ description: t('storyboard.imageSuccess') })
            break
          }
          if (status.status === 'failed') throw new Error(status.error || '')
          await wait(2500)
        }
      } catch (error) {
        if (mountedRef.current) {
          toast({
            variant: 'destructive',
            description:
              error instanceof Error && error.message ? error.message : t('storyboard.imageFailed'),
          })
        }
      } finally {
        activePollsRef.current.delete(pollKey)
        if (mountedRef.current) {
          setBusyIds(currentIds => {
            const next = new Set(currentIds)
            next.delete(storyboardId)
            return next
          })
          setProgress(0)
          await loadData(true)
        }
      }
    },
    [loadData, t, toast]
  )

  useEffect(() => {
    mountedRef.current = true
    void loadData()
    return () => {
      mountedRef.current = false
    }
  }, [loadData])

  useEffect(() => {
    for (const storyboard of storyboards) {
      if (
        (storyboard.generation_status === 1 || storyboard.generation_status === 2) &&
        storyboard.task_uuid
      ) {
        void pollImage(storyboard.task_uuid, storyboard.id)
      }
      const versions = storyboard.video_versions ?? []
      const generatingVersion = versions.find(version => isGenerating(version) && version.task_uuid)
      const fallback = storyboard.video_clip
      const taskUuid =
        generatingVersion?.task_uuid || (isGenerating(fallback) ? fallback?.task_uuid : null)
      if (taskUuid) void pollVideo(taskUuid, storyboard.id, storyboard.shot_id)
    }
  }, [pollImage, pollVideo, storyboards])

  const beginEdit = () => {
    if (!current) return
    setDraft({
      visual: current.visual,
      shots_prompt: current.shots_prompt || '',
      duration_seconds: current.duration_seconds,
      mood: current.mood,
      camera_notes: current.camera_notes,
      dialogue: current.dialogue || '',
      audio_sfx: current.audio_sfx || '',
    })
    setEditing(true)
  }

  const saveStoryboard = async () => {
    if (!current) return
    setSaving(true)
    try {
      const response = await storyboardApis.updateStoryboard(current.id, draft, false)
      toast({ description: response.message || t('storyboard.saveSuccess') })
      setEditing(false)
      await loadData(true)
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('storyboard.saveFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  const regenerateImage = async () => {
    if (!current) return
    try {
      const response = await storyboardApis.regenerateStoryboardImage(current.id, true)
      void pollImage(response.task_uuid, current.id)
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error && error.message ? error.message : t('storyboard.imageFailed'),
      })
    }
  }

  const handleGenerationResponse = async (
    response: VideoGenerateResponse,
    type: GenerationType
  ) => {
    if (!('task_uuid' in response)) {
      throw new Error(response.message)
    }
    if (type === 'single' && current) {
      void pollVideo(response.task_uuid, current.id, current.shot_id)
    } else {
      void pollVideo(response.task_uuid)
    }
  }

  const generateCurrentVideo = async () => {
    if (!current) return
    const params: GenerateSingleVideoParams = {
      storyboard_id: current.id,
      task_id: taskId,
      script_id: scriptId,
      shots_prompt: current.shots_prompt,
    }
    try {
      const response = await storyboardApis.generateSingleVideo(params)
      await handleGenerationResponse(response, 'single')
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('storyboard.generateFailed'),
      })
    }
  }

  const generateAllVideos = async () => {
    const params: GenerateAllVideosParams = { task_id: taskId, script_id: scriptId }
    try {
      const response = await storyboardApis.generateAllVideos(params)
      await handleGenerationResponse(response, 'all')
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('storyboard.generateFailed'),
      })
    }
  }

  const changeVersion = async (clipId: number) => {
    if (!current) return
    const previous = selectedVersions[current.id]
    setSelectedVersions(values => ({ ...values, [current.id]: clipId }))
    try {
      await storyboardApis.updateVideoSelection(scriptId, current.id, clipId)
    } catch (error) {
      setSelectedVersions(values => ({ ...values, [current.id]: previous }))
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('storyboard.versionFailed'),
      })
    }
  }

  const replaceImage = async (file: File) => {
    if (!current) return
    setReplacingImage(true)
    try {
      const response = await storyboardApis.replaceImage(current.id, file)
      toast({ description: response.message })
      await loadData(true)
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('storyboard.replaceFailed'),
      })
    } finally {
      setReplacingImage(false)
    }
  }

  const replaceVideo = async (file: File) => {
    if (!current) return
    setReplacingVideo(true)
    try {
      const response = await storyboardApis.replaceVideo(current.id, file)
      toast({ description: response.message })
      await loadData(true)
    } catch (error) {
      toast({
        variant: 'destructive',
        description: error instanceof Error ? error.message : t('storyboard.replaceFailed'),
      })
    } finally {
      setReplacingVideo(false)
    }
  }

  const mediaUrl = currentVideo?.model_video_url
  const imageUrl = current?.image_urls?.[0]
  const versions = current?.video_versions ?? []

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid="video-storyboard-panel">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {scriptState.title || t('storyboard.title')}
          </h2>
          <p className="text-xs text-text-secondary">
            {t('storyboard.count', { count: storyboards.length })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => void loadData(true)}
          data-testid="video-storyboard-refresh"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {t('storyboard.refresh')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={storyboards.length === 0}
          onClick={() => void generateAllVideos()}
          data-testid="video-storyboard-generate-all"
        >
          <WandSparkles className="mr-2 h-4 w-4" />
          {t('storyboard.generateAll')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasReadyVideos}
          onClick={() => setCompositionOpen(true)}
          data-testid="video-storyboard-open-composition"
        >
          <Clapperboard className="mr-2 h-4 w-4" />
          {t('storyboard.editVideo')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          data-testid="video-storyboard-close"
          aria-label={t('close')}
        >
          <X className="h-5 w-5" />
        </Button>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('storyboard.loading')}
        </div>
      ) : current ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
          <section className="flex min-h-[480px] min-w-0 flex-col lg:min-h-0">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <Button
                variant="outline"
                size="icon"
                disabled={currentIndex === 0}
                onClick={() => setCurrentIndex(index => Math.max(0, index - 1))}
                data-testid="video-storyboard-previous"
                aria-label={t('storyboard.previous')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-center">
                <div className="font-medium">
                  {t('storyboard.shot', { index: current.sequence_number + 1 })}
                </div>
                <div className="text-xs text-text-secondary">
                  {current.duration_seconds}s · {ratio || '16:9'}
                </div>
              </div>
              <Button
                variant="outline"
                size="icon"
                disabled={currentIndex >= storyboards.length - 1}
                onClick={() =>
                  setCurrentIndex(index => Math.min(storyboards.length - 1, index + 1))
                }
                data-testid="video-storyboard-next"
                aria-label={t('storyboard.next')}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="relative flex min-h-[300px] flex-1 items-center justify-center bg-black p-4">
              {mediaUrl && currentVideo?.generation_status === 3 ? (
                <video
                  controls
                  className="max-h-full max-w-full rounded-lg"
                  src={getAigcVideoPlaybackUrl(mediaUrl)}
                  poster={getAigcVideoImageUrl(currentVideo.video_cover_url || imageUrl)}
                  data-testid="video-storyboard-preview-video"
                />
              ) : imageUrl ? (
                <img
                  src={getAigcVideoImageUrl(imageUrl)}
                  alt={current.visual}
                  referrerPolicy="no-referrer"
                  className="max-h-full max-w-full rounded-lg object-contain"
                  data-testid="video-storyboard-preview-image"
                />
              ) : (
                <div className="text-sm text-white/60">{t('storyboard.noPreview')}</div>
              )}
              {currentBusy ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55 text-white">
                  <Loader2 className="h-7 w-7 animate-spin" />
                  <span>{t('storyboard.generating')}</span>
                  {progress > 0 ? <Progress value={progress} className="h-1.5 w-48" /> : null}
                </div>
              ) : null}
            </div>

            <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-border p-3">
              {storyboards.map((storyboard, index) => {
                const video = effectiveVideo(storyboard, selectedVersions[storyboard.id])
                const thumbnail = video?.video_cover_url || storyboard.image_urls?.[0]
                return (
                  <button
                    key={storyboard.id}
                    type="button"
                    onClick={() => setCurrentIndex(index)}
                    className={`relative h-20 w-28 shrink-0 overflow-hidden rounded-lg border-2 ${
                      index === currentIndex ? 'border-primary' : 'border-transparent'
                    }`}
                    data-testid={`video-storyboard-thumbnail-${storyboard.id}`}
                  >
                    {thumbnail ? (
                      <img
                        src={getAigcVideoImageUrl(thumbnail)}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full bg-muted" />
                    )}
                    <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-xs text-white">
                      #{storyboard.sequence_number + 1}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <aside className="min-h-0 space-y-5 overflow-y-auto border-l border-border p-4">
            {versions.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="storyboard-video-version">{t('storyboard.version')}</Label>
                <select
                  id="storyboard-video-version"
                  value={currentVersion?.id ?? ''}
                  onChange={event => void changeVersion(Number(event.target.value))}
                  className="h-11 w-full rounded-md border border-input bg-bg-base px-3 text-sm"
                  data-testid="video-storyboard-version"
                >
                  {versions
                    .slice()
                    .sort((a, b) => b.version_no - a.version_no)
                    .map(version => (
                      <option key={version.id} value={version.id}>
                        V{version.version_no}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}

            {editing ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="storyboard-visual">{t('storyboard.visual')}</Label>
                  <Textarea
                    id="storyboard-visual"
                    value={draft.visual || ''}
                    onChange={event =>
                      setDraft(value => ({ ...value, visual: event.target.value }))
                    }
                    rows={5}
                    data-testid="video-storyboard-edit-visual"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="storyboard-prompt">{t('storyboard.prompt')}</Label>
                  <Textarea
                    id="storyboard-prompt"
                    value={draft.shots_prompt || ''}
                    onChange={event =>
                      setDraft(value => ({ ...value, shots_prompt: event.target.value }))
                    }
                    rows={4}
                    data-testid="video-storyboard-edit-prompt"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="storyboard-duration">{t('storyboard.duration')}</Label>
                    <Input
                      id="storyboard-duration"
                      type="number"
                      min={1}
                      value={draft.duration_seconds || 1}
                      onChange={event =>
                        setDraft(value => ({
                          ...value,
                          duration_seconds: Number(event.target.value),
                        }))
                      }
                      data-testid="video-storyboard-edit-duration"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="storyboard-mood">{t('storyboard.mood')}</Label>
                    <Input
                      id="storyboard-mood"
                      value={draft.mood || ''}
                      onChange={event =>
                        setDraft(value => ({ ...value, mood: event.target.value }))
                      }
                      data-testid="video-storyboard-edit-mood"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => void saveStoryboard()}
                    disabled={saving}
                    data-testid="video-storyboard-save"
                  >
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t('storyboard.save')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setEditing(false)}
                    data-testid="video-storyboard-cancel-edit"
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-xs text-text-secondary">{t('storyboard.visual')}</div>
                  <p className="whitespace-pre-wrap text-sm leading-6">{current.visual || '-'}</p>
                </div>
                {current.shots_prompt ? (
                  <div>
                    <div className="mb-1 text-xs text-text-secondary">{t('storyboard.prompt')}</div>
                    <p className="whitespace-pre-wrap text-sm leading-6">{current.shots_prompt}</p>
                  </div>
                ) : null}
                <Button
                  variant="outline"
                  onClick={beginEdit}
                  data-testid="video-storyboard-start-edit"
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  {t('storyboard.edit')}
                </Button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
              <Button
                variant="outline"
                disabled={currentBusy}
                onClick={() => void regenerateImage()}
                data-testid="video-storyboard-regenerate-image"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('storyboard.regenerateImage')}
              </Button>
              <Button
                variant="outline"
                disabled={replacingImage}
                onClick={() => imageInputRef.current?.click()}
                data-testid="video-storyboard-replace-image"
              >
                {replacingImage ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ImageUp className="mr-2 h-4 w-4" />
                )}
                {t('storyboard.replaceImage')}
              </Button>
              <Button
                variant="outline"
                disabled={currentBusy}
                onClick={() => void generateCurrentVideo()}
                data-testid="video-storyboard-generate-video"
              >
                <Play className="mr-2 h-4 w-4" />
                {t('storyboard.generateVideo')}
              </Button>
              <Button
                variant="outline"
                disabled={replacingVideo}
                onClick={() => videoInputRef.current?.click()}
                data-testid="video-storyboard-replace-video"
              >
                {replacingVideo ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {t('storyboard.replaceVideo')}
              </Button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) void replaceImage(file)
                  event.currentTarget.value = ''
                }}
                data-testid="video-storyboard-image-input"
              />
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) void replaceVideo(file)
                  event.currentTarget.value = ''
                }}
                data-testid="video-storyboard-video-input"
              />
            </div>
          </aside>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
          {t('storyboard.empty')}
        </div>
      )}

      <Dialog open={compositionOpen} onOpenChange={setCompositionOpen}>
        <DialogContent
          className="z-[2147483640] h-dvh w-screen max-w-none gap-0 rounded-none border-0 p-0"
          hideCloseButton
        >
          <DialogTitle className="sr-only">{t('composition.title')}</DialogTitle>
          {compositionOpen ? (
            <CompositionEditor
              scriptId={scriptId}
              taskId={taskId}
              storyboards={storyboards}
              selectedVersionMap={selectedVersions}
              bgm={scriptState.bgm}
              bgmEnabled={scriptState.bgmEnabled}
              subtitleEnabled={scriptState.subtitleEnabled}
              finalVideoCover={scriptState.finalVideoCover}
              onClose={() => setCompositionOpen(false)}
              onGenerateFinalVideo={onGenerateFinalVideo}
              onSaved={() => void loadData(true)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
