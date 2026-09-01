// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * StoryboardPanel – 720px right-side panel for storyboard management.
 *
 * Layout: Fixed right panel (same as EntityPanel), chat area remains visible.
 * Uses carousel view with video preview, thumbnail strip, and inline description editing.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CarouselView } from '@wecode/features/video/components/CarouselView'
import {
  storyboardApis,
  type Storyboard,
  type StoryboardListResponse,
  type StoryboardVideoVersion,
  type VideoClip,
} from './api'
import { toast } from '@/hooks/use-toast'
import { scriptApi } from '@wecode/features/video/script/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { ThumbnailItem } from '@wecode/features/video/entity/EntityThumbnailStrip'
import { StoryboardVideoPreview } from './StoryboardVideoPreview'
import { StoryboardVersionSelector } from './StoryboardVersionSelector'
import { getRatioDimensions } from '@wecode/features/video/components/ratioDimensions'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { PanelCloseButton } from '@wecode/features/video/components/PanelCloseButton'
import { CompositionEditor } from '@wecode/features/video/composition'
import { ApiError } from '@/apis/client'
import {
  hasGeneratingStoryboardClip,
  hasPendingStoryboardGeneration,
  hasSuccessfulSelectedStoryboardVersion,
} from './generationAvailability'
import { getAigcVideoImageUrl } from '../aigc_video/mediaUrls'
import videoThemeStyles from '../components/videoTheme.module.css'

interface StoryboardPanelProps {
  scriptId: number
  taskId: number
  initialIndex?: number
  scriptTitle?: string
  onClose: () => void
  embedded?: boolean // Embedded mode: no fixed positioning, used in split view
  readOnly?: boolean // Read-only mode: disable editing
  shareToken?: string // Share token for public shared task access
  onGenerateFinalVideo?: () => Promise<void> | void
  isGeneratingFinalVideo?: boolean
}

// Script detail state
type ScriptDetailState = {
  title: string
  bgm: import('@wecode/features/video/composition/types').CompositionBgm[]
  bgmEnabled: boolean
  subtitleEnabled: boolean
  finalVideoCover: import('@wecode/features/video/script/types').FinalVideoCover | null
  loading: boolean
}

function getEffectiveVersion(storyboard: Storyboard, selectedClipId?: number | null) {
  const versions = storyboard.video_versions ?? []
  if (versions.length === 0) return null

  const targetId = selectedClipId ?? storyboard.selected_video_clip_id
  if (targetId != null) {
    const matched = versions.find(version => version.id === targetId)
    if (matched) return matched
  }

  return versions.find(version => version.is_selected) ?? versions[0] ?? null
}

function versionToVideoClip(version: StoryboardVideoVersion | null, fallback: VideoClip | null) {
  if (!version) return fallback
  return {
    id: version.id,
    generation_status: version.generation_status,
    progress: version.progress,
    model_video_url: version.model_video_url,
    video_cover_url: version.video_cover_url,
    media_id: version.media_id,
    duration: version.duration,
    error_message: version.error_message,
    task_uuid: version.task_uuid ?? null,
  }
}

function getGeneratingVersion(storyboard: Storyboard) {
  return (storyboard.video_versions ?? []).find(
    version =>
      (version.generation_status === 1 || version.generation_status === 2) &&
      Boolean(version.task_uuid)
  )
}

function applySelectedClipToStoryboard(storyboard: Storyboard, clipId: number): Storyboard {
  return {
    ...storyboard,
    selected_video_clip_id: clipId,
    video_versions: (storyboard.video_versions ?? []).map(version => ({
      ...version,
      is_selected: version.id === clipId,
    })),
  }
}

export function StoryboardPanel({
  scriptId,
  taskId,
  initialIndex = 0,
  scriptTitle,
  onClose,
  embedded = true,
  readOnly = false,
  shareToken,
  onGenerateFinalVideo,
  isGeneratingFinalVideo = false,
}: StoryboardPanelProps) {
  const [storyboards, setStoryboards] = useState<Storyboard[]>([])
  const [loading, setLoading] = useState(true)

  // Mobile detection for responsive sizing
  const isMobile = useIsMobile()

  // Script detail state
  const [scriptState, setScriptState] = useState<ScriptDetailState>({
    title: scriptTitle || '',
    bgm: [],
    bgmEnabled: true,
    subtitleEnabled: true,
    finalVideoCover: null,
    loading: !scriptTitle,
  })

  // ... existing code ...

  // Video generation state
  const [videoGeneratingIds, setVideoGeneratingIds] = useState<number[]>([])
  const videoGeneratingIdsRef = useRef<number[]>([])
  const [_videoProgressMap, setVideoProgressMap] = useState<Record<number, number>>({})
  const pollTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const [selectedVersionMap, setSelectedVersionMap] = useState<Record<number, number>>({})

  // Billing confirmation state
  const [pendingCharge, setPendingCharge] = useState<
    | {
        mode: 'single'
        storyboardId: number
        billingToken: string
        message: string
        creditCost?: number
        shotsPrompt?: string
      }
    | {
        mode: 'bulk'
        storyboardIds: number[]
        billingToken: string
        message: string
        creditCost?: number
      }
    | null
  >(null)
  // Keep ref in sync with state for fetchData access
  useEffect(() => {
    videoGeneratingIdsRef.current = videoGeneratingIds
  }, [videoGeneratingIds])

  // Editing state
  const [isEditing, setIsEditing] = useState(false)
  const [editDescription, setEditDescription] = useState('')

  // Composition editor state
  const [isCompositionEditorOpen, setIsCompositionEditorOpen] = useState(false)
  const beforeCloseRef = useRef<(() => boolean) | null>(null)

  // Refs to avoid circular dependencies
  const fetchDataRef = useRef<(silent?: boolean) => Promise<StoryboardListResponse | null>>(
    async () => null
  )

  // i18n
  const { t } = useTranslation('video')

  // Build request options based on shareToken
  const requestOptions = useMemo(() => ({ shareToken }), [shareToken])

  // Carousel state
  const [currentIndex, setCurrentIndex] = useState(Math.max(initialIndex, 0))

  const flattenedItems = useMemo<ThumbnailItem[]>(
    () =>
      storyboards.map(sb => {
        const currentStoryboardVideoClip = versionToVideoClip(
          getEffectiveVersion(sb, selectedVersionMap[sb.id]),
          sb.video_clip
        )
        const isGenerating =
          videoGeneratingIds.includes(sb.id) ||
          sb.generation_status === 1 ||
          currentStoryboardVideoClip?.generation_status === 1 ||
          currentStoryboardVideoClip?.generation_status === 2

        return {
          id: sb.id,
          // 优先使用视频封面，其次是首帧图片
          image_url:
            getAigcVideoImageUrl(
              currentStoryboardVideoClip?.video_cover_url || sb.image_urls[0],
              shareToken
            ) || '',
          entity_name: `${t('video')}${(sb.sequence_number ?? 0) + 1}`,
          // 视频生成中或首帧生成中显示 loading
          isGenerating,
          hasPendingGeneration: Boolean(
            sb.has_pending_video_generation &&
            !isGenerating &&
            !currentStoryboardVideoClip?.model_video_url
          ),
        }
      }),
    [selectedVersionMap, shareToken, storyboards, t, videoGeneratingIds]
  )

  // Clamp index when storyboards change
  useEffect(() => {
    if (flattenedItems.length > 0 && currentIndex >= flattenedItems.length) {
      setCurrentIndex(flattenedItems.length - 1)
    }
  }, [flattenedItems.length, currentIndex])

  const prev = useCallback(() => setCurrentIndex(i => (i > 0 ? i - 1 : i)), [])
  const next = useCallback(
    () => setCurrentIndex(i => (i < flattenedItems.length - 1 ? i + 1 : i)),
    [flattenedItems.length]
  )
  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < flattenedItems.length) {
        setCurrentIndex(index)
      }
    },
    [flattenedItems.length]
  )

  // Cleanup poll timers
  useEffect(() => {
    const timers = pollTimersRef.current
    return () => {
      Object.values(timers).forEach(clearTimeout)
    }
  }, [])

  // Store ratio from API response
  const [ratio, setRatio] = useState<string | undefined>(undefined)

  // Fetch script title from aigc-video API
  const fetchScriptTitle = useCallback(async () => {
    try {
      const script = await scriptApi.getScript(scriptId, requestOptions)
      setScriptState({
        title: script.title,
        bgm: (script.bgm ?? []).map(b => ({ ...b, volume: b.volume ?? 0.5 })),
        bgmEnabled: script.global_style?.bgm_enabled ?? true,
        subtitleEnabled: script.global_style?.subtitle_enabled ?? true,
        finalVideoCover: script.final_video_cover ?? null,
        loading: false,
      })
    } catch (err) {
      console.error('Failed to fetch script title:', err)
      setScriptState(prev => ({ ...prev, loading: false }))
    }
  }, [scriptId, requestOptions])

  // Poll video status - extracted for reuse in fetchData
  const pollVideoStatus = useCallback(
    async (storyboardId: number, taskUuid: string, shotId?: string) => {
      try {
        const status = await storyboardApis.getVideoTaskStatus(taskUuid, shotId)
        if (status.status === 'completed') {
          setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
          setVideoProgressMap(prev => {
            const next = { ...prev }
            delete next[storyboardId]
            return next
          })
          delete pollTimersRef.current[storyboardId]
          await fetchDataRef.current?.(true)
          const successMsg =
            status.task_type === 'batch'
              ? t('video_generate_success')
              : t('video_regenerate_success')
          toast({ description: successMsg })
        } else if (status.status === 'failed') {
          setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
          setVideoProgressMap(prev => {
            const next = { ...prev }
            delete next[storyboardId]
            return next
          })
          delete pollTimersRef.current[storyboardId]
          console.error('Video regeneration failed:', status.error)
          const failedMsg =
            status.task_type === 'batch' ? t('video_generate_failed') : t('video_regenerate_failed')
          toast({ description: failedMsg, variant: 'destructive' })
          await fetchDataRef.current?.(true)
        } else {
          const percentage = status.progress?.percentage ?? 0
          setVideoProgressMap(prev => ({ ...prev, [storyboardId]: percentage }))
          pollTimersRef.current[storyboardId] = setTimeout(
            () => pollVideoStatus(storyboardId, taskUuid, shotId),
            3000
          )
        }
      } catch (err) {
        console.error('Failed to poll video status:', err)
        if (err instanceof ApiError && err.status === 404) {
          setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
          setVideoProgressMap(prev => {
            const next = { ...prev }
            delete next[storyboardId]
            return next
          })
          delete pollTimersRef.current[storyboardId]
          await fetchDataRef.current?.(true)
          return
        }
        pollTimersRef.current[storyboardId] = setTimeout(
          () => pollVideoStatus(storyboardId, taskUuid, shotId),
          5000
        )
      }
    },
    [t]
  )

  // Fetch storyboard data and restore polling for pending tasks
  const fetchData = useCallback(
    async (silent = false): Promise<StoryboardListResponse | null> => {
      try {
        if (!silent) setLoading(true)
        const res = await storyboardApis.getStoryboards(scriptId, requestOptions)
        setStoryboards(res.storyboards)
        setSelectedVersionMap(
          Object.fromEntries(
            res.storyboards
              .map(sb => {
                const version = getEffectiveVersion(sb)
                return version ? [sb.id, version.id] : null
              })
              .filter((item): item is [number, number] => item !== null)
          )
        )
        setRatio(res.ratio)

        // Restore polling for storyboards with pending video generation (status 1=提交中, 2=生成中)
        for (const sb of res.storyboards) {
          const currentVideoClip = versionToVideoClip(getEffectiveVersion(sb), sb.video_clip)
          const generatingVersion = getGeneratingVersion(sb)
          const pollTaskUuid = generatingVersion?.task_uuid || currentVideoClip?.task_uuid
          if (
            pollTaskUuid &&
            (Boolean(generatingVersion) ||
              currentVideoClip?.generation_status === 1 ||
              currentVideoClip?.generation_status === 2)
          ) {
            // Skip if already polling for this storyboard (in generating list or has active timer)
            if (videoGeneratingIdsRef.current.includes(sb.id) || pollTimersRef.current[sb.id]) {
              continue
            }
            setVideoGeneratingIds(prev => [...prev, sb.id])
            setVideoProgressMap(prev => ({
              ...prev,
              [sb.id]: generatingVersion?.progress || currentVideoClip?.progress || 0,
            }))
            // Start polling with shot_id
            pollVideoStatus(sb.id, pollTaskUuid, sb.shot_id)
          }
        }
        return res
      } catch (err) {
        console.error('Failed to fetch storyboards:', err)
        return null
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [scriptId, pollVideoStatus, requestOptions]
  )

  // Update ref for use in pollVideoStatus
  useEffect(() => {
    fetchDataRef.current = fetchData
  }, [fetchData])

  useEffect(() => {
    // Fetch script title if not provided
    if (!scriptTitle) {
      fetchScriptTitle()
    }
  }, [scriptTitle, fetchScriptTitle])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ESC key handler (no body scroll lock — side panel doesn't need it)
  const isCompositionEditorOpenRef = useRef(isCompositionEditorOpen)
  isCompositionEditorOpenRef.current = isCompositionEditorOpen

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Do nothing if the composition editor is open — let the Dialog handle ESC.
        // Use ref to avoid stale closure issues with Radix Dialog capture-phase handling.
        if (isCompositionEditorOpenRef.current) return
        if (isEditing) {
          setIsEditing(false)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, onClose])

  // Cancel editing when switching storyboards
  useEffect(() => {
    setIsEditing(false)
  }, [currentIndex])

  // Current storyboard
  const currentStoryboard = storyboards[currentIndex]
  const currentVersion = currentStoryboard
    ? getEffectiveVersion(currentStoryboard, selectedVersionMap[currentStoryboard.id])
    : null
  const currentVideoClip = currentStoryboard
    ? versionToVideoClip(currentVersion, currentStoryboard.video_clip)
    : null
  const hasAnyGeneratingVersion = hasGeneratingStoryboardClip(currentStoryboard ?? null)
  const currentDescription =
    currentVersion?.shots_prompt ||
    currentVersion?.visual ||
    currentStoryboard?.shots_prompt ||
    currentStoryboard?.visual ||
    ''
  const previewStoryboard = currentStoryboard
    ? {
        ...currentStoryboard,
        shots_prompt: currentDescription,
        video_clip: currentVideoClip,
      }
    : null
  const isVideoGenerating = Boolean(
    currentVideoClip &&
    (currentVideoClip.generation_status === 1 || currentVideoClip.generation_status === 2)
  )
  const isPendingVideoGeneration = Boolean(
    currentStoryboard?.has_pending_video_generation &&
    !isVideoGenerating &&
    !currentVideoClip?.model_video_url
  )
  const generateAllCandidateStoryboards = useMemo(
    () => storyboards.filter(sb => Boolean(sb.has_pending_video_generation)),
    [storyboards]
  )
  const canGenerateAllStoryboards = hasPendingStoryboardGeneration(storyboards)
  const isGenerateAllDisabled = !canGenerateAllStoryboards
  const canComposeStoryboardVideo = hasSuccessfulSelectedStoryboardVersion(
    storyboards,
    selectedVersionMap
  )

  const canShowGenerateFinalVideoButton = Boolean(onGenerateFinalVideo) && !readOnly
  const isGenerateFinalVideoDisabled = isGeneratingFinalVideo || !canComposeStoryboardVideo

  const handleVersionChange = useCallback(
    async (storyboardId: number, clipId: number) => {
      const previousStoryboards = storyboards
      const previousSelectedMap = selectedVersionMap

      setSelectedVersionMap(prev => ({ ...prev, [storyboardId]: clipId }))
      setStoryboards(prev =>
        prev.map(sb => (sb.id === storyboardId ? applySelectedClipToStoryboard(sb, clipId) : sb))
      )

      try {
        await storyboardApis.updateStoryboardVideoSelection(scriptId, storyboardId, clipId)
      } catch (err) {
        setSelectedVersionMap(previousSelectedMap)
        setStoryboards(previousStoryboards)
        const errorMessage = err instanceof Error ? err.message : t('save_failed')
        toast({ description: errorMessage, variant: 'destructive' })
      }
    },
    [scriptId, selectedVersionMap, storyboards, t]
  )

  const autoSelectGeneratedVersion = useCallback(
    async (storyboardId: number, taskUuid: string, fetchedStoryboards?: Storyboard[]) => {
      const latestStoryboard = (fetchedStoryboards ?? storyboards).find(
        sb => sb.id === storyboardId
      )
      const matchedVersion = latestStoryboard?.video_versions?.find(
        version => version.task_uuid === taskUuid
      )
      if (!matchedVersion) return

      setSelectedVersionMap(prev => ({ ...prev, [storyboardId]: matchedVersion.id }))
      setStoryboards(prev =>
        prev.map(sb =>
          sb.id === storyboardId ? applySelectedClipToStoryboard(sb, matchedVersion.id) : sb
        )
      )

      try {
        await storyboardApis.updateStoryboardVideoSelection(
          scriptId,
          storyboardId,
          matchedVersion.id
        )
      } catch (err) {
        console.error('Failed to persist auto-selected storyboard video version:', err)
      }
    },
    [scriptId, storyboards]
  )

  const pollGenerateAllStatus = useCallback(
    async (taskUuid: string, storyboardIds: number[]) => {
      const clearBulkGeneratingState = (ids: number[] = storyboardIds) => {
        setVideoGeneratingIds(prev => prev.filter(id => !ids.includes(id)))
        setVideoProgressMap(prev => {
          const next = { ...prev }
          ids.forEach(id => {
            delete next[id]
            delete pollTimersRef.current[id]
          })
          return next
        })
      }

      try {
        const status = await storyboardApis.getVideoTaskStatus(taskUuid)
        const shotIdByStoryboardId = new Map(
          storyboards
            .filter(sb => storyboardIds.includes(sb.id))
            .map(sb => [sb.id, sb.shot_id] as const)
        )
        const finishedIds: number[] = []
        const progressEntries: Array<[number, number]> = []

        for (const storyboardId of storyboardIds) {
          const shotId = shotIdByStoryboardId.get(storyboardId)
          const shotStatus = shotId ? status.shot_statuses?.[shotId] : undefined
          if (!shotStatus) continue
          if (shotStatus.status === 'completed' || shotStatus.status === 'failed') {
            finishedIds.push(storyboardId)
            continue
          }
          progressEntries.push([
            storyboardId,
            shotStatus.progress ?? status.progress?.percentage ?? 0,
          ])
        }

        if (finishedIds.length > 0) {
          clearBulkGeneratingState(finishedIds)
          await fetchDataRef.current?.(true)
        }
        const activeStoryboardIds = storyboardIds.filter(id => !finishedIds.includes(id))

        if (status.status === 'completed') {
          clearBulkGeneratingState()
          await fetchDataRef.current?.(true)
          toast({ description: t('video_generate_success') })
        } else if (status.status === 'failed') {
          clearBulkGeneratingState()
          toast({ description: status.error || t('video_generate_failed'), variant: 'destructive' })
          await fetchDataRef.current?.(true)
        } else {
          const percentage = status.progress?.percentage ?? 0
          setVideoProgressMap(prev => ({
            ...prev,
            ...Object.fromEntries(
              progressEntries.length > 0
                ? progressEntries
                : activeStoryboardIds.map(id => [id, percentage])
            ),
          }))
          const timerIds = activeStoryboardIds.length > 0 ? activeStoryboardIds : storyboardIds
          const timer = setTimeout(() => pollGenerateAllStatus(taskUuid, timerIds), 3000)
          timerIds.forEach(id => {
            pollTimersRef.current[id] = timer
          })
        }
      } catch (err) {
        console.error('Failed to poll bulk video status:', err)
        const timer = setTimeout(() => pollGenerateAllStatus(taskUuid, storyboardIds), 5000)
        storyboardIds.forEach(id => {
          pollTimersRef.current[id] = timer
        })
      }
    },
    [storyboards, t]
  )

  const handleInsufficientCredits = useCallback(
    async (..._details: unknown[]) => {
      toast({ description: t('video_generate_failed'), variant: 'destructive' })
    },
    [t]
  )

  const handleKnownCreditShortfall = useCallback(async (..._details: unknown[]) => false, [])

  const handleBillingError = useCallback(
    async (_message: string | undefined, fallbackMessage: string, ..._details: unknown[]) => {
      toast({ description: fallbackMessage, variant: 'destructive' })
    },
    []
  )

  const handleRequestError = useCallback(async (_error: unknown, fallbackMessage: string) => {
    toast({ description: fallbackMessage, variant: 'destructive' })
  }, [])

  // Handle billing confirmation - second request with confirm_charge=true
  const handleConfirmCharge = useCallback(async () => {
    if (!pendingCharge) return

    if (pendingCharge.mode === 'bulk') {
      const storyboardIds = pendingCharge.storyboardIds
      const clearBulkGeneratingState = () => {
        setVideoGeneratingIds(prev => prev.filter(id => !storyboardIds.includes(id)))
        setVideoProgressMap(prev => {
          const next = { ...prev }
          storyboardIds.forEach(id => {
            delete next[id]
            delete pollTimersRef.current[id]
          })
          return next
        })
      }

      try {
        setVideoGeneratingIds(prev => [...new Set([...prev, ...storyboardIds])])
        setVideoProgressMap(prev => ({
          ...prev,
          ...Object.fromEntries(storyboardIds.map(id => [id, 0])),
        }))

        const res = await storyboardApis.generateAllVideos({
          task_id: taskId,
          script_id: scriptId,
          confirm_charge: true,
          billing_token: pendingCharge.billingToken,
        })

        if (res.action === 'insufficient_credits') {
          setPendingCharge(null)
          clearBulkGeneratingState()
          await handleInsufficientCredits(res.message, res.credit_cost, res.balance)
          return
        }

        if (res.action === 'billing_error') {
          clearBulkGeneratingState()
          await handleBillingError(
            res.message,
            t('video_generate_failed'),
            res.credit_cost,
            res.balance
          )
          return
        }

        if (res.action !== 'charged_generate' && res.action !== 'free_generate') {
          clearBulkGeneratingState()
          toast({ description: t('video_generate_failed'), variant: 'destructive' })
          return
        }

        setPendingCharge(null)
        await fetchDataRef.current?.(true)
        const timer = setTimeout(() => pollGenerateAllStatus(res.task_uuid, storyboardIds), 3000)
        storyboardIds.forEach(id => {
          pollTimersRef.current[id] = timer
        })
        return
      } catch (err) {
        console.error('Failed to confirm bulk charge:', err)
        clearBulkGeneratingState()
        await handleRequestError(err, t('video_generate_failed'))
        return
      }
    }

    const storyboardId = pendingCharge.storyboardId
    const storyboard = storyboards.find(item => item.id === storyboardId)
    if (!storyboard) {
      setPendingCharge(null)
      return
    }

    const clearVideoGeneratingState = () => {
      setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
      setVideoProgressMap(prev => {
        const next = { ...prev }
        delete next[storyboardId]
        return next
      })
    }

    try {
      setVideoGeneratingIds(prev => [...prev, storyboardId])
      setVideoProgressMap(prev => ({ ...prev, [storyboardId]: 0 }))

      const res = await storyboardApis.generateSingleVideo({
        storyboard_id: storyboardId,
        task_id: taskId,
        script_id: scriptId,
        confirm_charge: true,
        billing_token: pendingCharge.billingToken,
        shots_prompt: pendingCharge.shotsPrompt,
      })

      if (res.action === 'insufficient_credits') {
        setPendingCharge(null)
        clearVideoGeneratingState()
        await handleInsufficientCredits(res.message, res.credit_cost, res.balance)
        return
      }

      if (res.action === 'billing_error') {
        clearVideoGeneratingState()
        await handleBillingError(
          res.message,
          t('video_regenerate_failed'),
          res.credit_cost,
          res.balance
        )
        return
      }

      if (res.action !== 'charged_generate' && res.action !== 'free_generate') {
        clearVideoGeneratingState()
        toast({ description: t('video_regenerate_failed'), variant: 'destructive' })
        return
      }

      setPendingCharge(null)
      if (pendingCharge.shotsPrompt != null) {
        setIsEditing(false)
      }

      const refreshed = await fetchDataRef.current?.(true)
      await autoSelectGeneratedVersion(storyboardId, res.task_uuid, refreshed?.storyboards)
      if (!pollTimersRef.current[storyboardId]) {
        pollTimersRef.current[storyboardId] = setTimeout(
          () => pollVideoStatus(storyboardId, res.task_uuid, storyboard.shot_id),
          3000
        )
      }
    } catch (err) {
      console.error('Failed to confirm charge:', err)
      clearVideoGeneratingState()
      await handleRequestError(err, t('video_regenerate_failed'))
    }
  }, [
    autoSelectGeneratedVersion,
    handleBillingError,
    handleInsufficientCredits,
    handleRequestError,
    pendingCharge,
    pollGenerateAllStatus,
    pollVideoStatus,
    scriptId,
    storyboards,
    t,
    taskId,
  ])

  useEffect(() => {
    if (pendingCharge) void handleConfirmCharge()
  }, [handleConfirmCharge, pendingCharge])

  // Regenerate storyboard video with polling and billing confirmation
  const handleRegenerate = useCallback(async () => {
    if (!currentStoryboard) return
    if (hasGeneratingStoryboardClip(currentStoryboard)) {
      toast({
        description: '当前分镜视频正在生成中，请等待完成后再重新生成',
        variant: 'destructive',
      })
      return
    }
    const storyboardId = currentStoryboard.id
    const clearVideoGeneratingState = () => {
      setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
      setVideoProgressMap(prev => {
        const next = { ...prev }
        delete next[storyboardId]
        return next
      })
    }

    try {
      setVideoGeneratingIds(prev => [...prev, storyboardId])
      setVideoProgressMap(prev => ({ ...prev, [storyboardId]: 0 }))

      const res = await storyboardApis.generateSingleVideo({
        storyboard_id: storyboardId,
        task_id: taskId,
        script_id: scriptId,
      })

      // Handle different response types based on billing
      if (res.action === 'confirm_charge') {
        clearVideoGeneratingState()
        if (await handleKnownCreditShortfall(res.message, res.credit_cost)) {
          return
        }
        setPendingCharge({
          mode: 'single',
          storyboardId,
          billingToken: res.billing_token,
          message: res.message,
          creditCost: res.credit_cost,
        })
        return
      }

      if (res.action === 'insufficient_credits') {
        clearVideoGeneratingState()
        await handleInsufficientCredits(res.message, res.credit_cost, res.balance)
        return
      }

      if (res.action === 'billing_error') {
        clearVideoGeneratingState()
        await handleBillingError(
          res.message,
          t('video_regenerate_failed'),
          res.credit_cost,
          res.balance
        )
        return
      }

      if (res.action !== 'charged_generate' && res.action !== 'free_generate') {
        clearVideoGeneratingState()
        toast({ description: t('video_regenerate_failed'), variant: 'destructive' })
        return
      }

      const refreshed = await fetchDataRef.current?.(true)
      await autoSelectGeneratedVersion(storyboardId, res.task_uuid, refreshed?.storyboards)
      if (!pollTimersRef.current[storyboardId]) {
        pollTimersRef.current[storyboardId] = setTimeout(
          () => pollVideoStatus(storyboardId, res.task_uuid, currentStoryboard.shot_id),
          3000
        )
      }
    } catch (err) {
      console.error('Failed to regenerate video:', err)
      clearVideoGeneratingState()
      await handleRequestError(err, t('video_regenerate_failed'))
    }
  }, [
    autoSelectGeneratedVersion,
    currentStoryboard,
    handleBillingError,
    handleInsufficientCredits,
    handleKnownCreditShortfall,
    handleRequestError,
    pollVideoStatus,
    scriptId,
    t,
    taskId,
  ])

  // Handle "重新编辑" — enter edit mode for visual description
  // Priority: shots_prompt > visual
  const handleEditStart = useCallback(() => {
    if (!currentStoryboard) return
    const description = currentDescription
    setEditDescription(description)
    setIsEditing(true)
  }, [currentDescription, currentStoryboard])

  const handleEditCancel = useCallback(() => {
    setIsEditing(false)
  }, [])

  // Save edited visual description and auto-trigger video regeneration
  // Save to shots_prompt field, fallback to visual for display
  const handleEditSave = useCallback(async () => {
    if (!currentStoryboard) return
    if (hasAnyGeneratingVersion) {
      toast({
        description: '当前分镜视频正在生成中，请等待完成后再编辑',
        variant: 'destructive',
      })
      return
    }
    const storyboardId = currentStoryboard.id
    const clearVideoGeneratingState = () => {
      setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
      setVideoProgressMap(prev => {
        const next = { ...prev }
        delete next[storyboardId]
        return next
      })
    }

    try {
      setVideoGeneratingIds(prev => [...prev, storyboardId])
      setVideoProgressMap(prev => ({ ...prev, [storyboardId]: 0 }))

      const res = await storyboardApis.generateSingleVideo({
        storyboard_id: storyboardId,
        task_id: taskId,
        script_id: scriptId,
        shots_prompt: editDescription,
      })

      if (res.action === 'confirm_charge') {
        clearVideoGeneratingState()
        if (await handleKnownCreditShortfall(res.message, res.credit_cost)) {
          return
        }
        setPendingCharge({
          mode: 'single',
          storyboardId,
          billingToken: res.billing_token,
          message: res.message,
          shotsPrompt: editDescription,
          creditCost: res.credit_cost,
        })
        return
      }

      if (res.action === 'insufficient_credits') {
        clearVideoGeneratingState()
        await handleInsufficientCredits(res.message, res.credit_cost, res.balance)
        return
      }

      if (res.action === 'billing_error') {
        clearVideoGeneratingState()
        await handleBillingError(res.message, t('save_failed'), res.credit_cost, res.balance)
        return
      }

      if (res.action !== 'charged_generate' && res.action !== 'free_generate') {
        clearVideoGeneratingState()
        toast({ description: t('save_failed'), variant: 'destructive' })
        return
      }

      setIsEditing(false)
      const refreshed = await fetchDataRef.current?.(true)
      await autoSelectGeneratedVersion(storyboardId, res.task_uuid, refreshed?.storyboards)
      if (!pollTimersRef.current[storyboardId]) {
        pollTimersRef.current[storyboardId] = setTimeout(
          () => pollVideoStatus(storyboardId, res.task_uuid, currentStoryboard.shot_id),
          3000
        )
      }
    } catch (err) {
      console.error('Failed to save storyboard:', err)
      clearVideoGeneratingState()
      await handleRequestError(err, t('save_failed'))
    }
  }, [
    autoSelectGeneratedVersion,
    currentStoryboard,
    editDescription,
    handleBillingError,
    hasAnyGeneratingVersion,
    handleInsufficientCredits,
    handleKnownCreditShortfall,
    handleRequestError,
    pollVideoStatus,
    scriptId,
    t,
    taskId,
  ])

  // Generate a pending video. Its displayed credit cost serves as confirmation.
  const handleGenerateVideo = useCallback(async () => {
    if (!currentStoryboard) return
    if (currentStoryboard.generation_status !== 2) return
    if (hasGeneratingStoryboardClip(currentStoryboard)) {
      toast({
        description: '当前分镜视频正在生成中，请等待完成后再操作',
        variant: 'destructive',
      })
      return
    }

    const storyboardId = currentStoryboard.id
    const clearVideoGeneratingState = () => {
      setVideoGeneratingIds(prev => prev.filter(id => id !== storyboardId))
      setVideoProgressMap(prev => {
        const next = { ...prev }
        delete next[storyboardId]
        return next
      })
    }

    try {
      setVideoGeneratingIds(prev => [...prev, storyboardId])
      setVideoProgressMap(prev => ({ ...prev, [storyboardId]: 0 }))

      let res = await storyboardApis.generateSingleVideo({
        storyboard_id: storyboardId,
        task_id: taskId,
        script_id: scriptId,
      })

      // Handle different response types based on billing
      if (res.action === 'confirm_charge') {
        if (await handleKnownCreditShortfall(res.message, res.credit_cost)) {
          clearVideoGeneratingState()
          return
        }
        res = await storyboardApis.generateSingleVideo({
          storyboard_id: storyboardId,
          task_id: taskId,
          script_id: scriptId,
          confirm_charge: true,
          billing_token: res.billing_token,
        })
      }

      if (res.action === 'insufficient_credits') {
        clearVideoGeneratingState()
        await handleInsufficientCredits(res.message, res.credit_cost, res.balance)
        return
      }

      if (res.action === 'billing_error') {
        clearVideoGeneratingState()
        await handleBillingError(
          res.message,
          t('video_regenerate_failed'),
          res.credit_cost,
          res.balance
        )
        return
      }

      if (res.action !== 'charged_generate' && res.action !== 'free_generate') {
        clearVideoGeneratingState()
        toast({ description: t('video_regenerate_failed'), variant: 'destructive' })
        return
      }

      const refreshed = await fetchDataRef.current?.(true)
      await autoSelectGeneratedVersion(storyboardId, res.task_uuid, refreshed?.storyboards)
      if (!pollTimersRef.current[storyboardId]) {
        pollTimersRef.current[storyboardId] = setTimeout(
          () => pollVideoStatus(storyboardId, res.task_uuid, currentStoryboard.shot_id),
          3000
        )
      }
    } catch (err) {
      console.error('Failed to generate video:', err)
      clearVideoGeneratingState()
      await handleRequestError(err, t('video_regenerate_failed'))
    }
  }, [
    autoSelectGeneratedVersion,
    currentStoryboard,
    handleBillingError,
    handleInsufficientCredits,
    handleKnownCreditShortfall,
    handleRequestError,
    pollVideoStatus,
    scriptId,
    t,
    taskId,
  ])

  const handleGenerateAll = useCallback(async () => {
    if (!canGenerateAllStoryboards) return

    try {
      const res = await storyboardApis.generateAllVideos({
        task_id: taskId,
        script_id: scriptId,
      })

      if (res.action === 'confirm_charge') {
        if (await handleKnownCreditShortfall(res.message, res.credit_cost)) {
          return
        }
        setPendingCharge({
          mode: 'bulk',
          storyboardIds: generateAllCandidateStoryboards.map(sb => sb.id),
          billingToken: res.billing_token,
          message: res.message,
          creditCost: res.credit_cost,
        })
        return
      }

      if (res.action === 'insufficient_credits') {
        await handleInsufficientCredits(res.message, res.credit_cost, res.balance)
        return
      }

      if (res.action === 'billing_error') {
        await handleBillingError(
          res.message,
          t('video_generate_failed'),
          res.credit_cost,
          res.balance
        )
        return
      }

      if (res.action !== 'charged_generate' && res.action !== 'free_generate') {
        toast({ description: t('video_generate_failed'), variant: 'destructive' })
        return
      }

      const storyboardIds = generateAllCandidateStoryboards.map(sb => sb.id)
      setVideoGeneratingIds(prev => [...new Set([...prev, ...storyboardIds])])
      setVideoProgressMap(prev => ({
        ...prev,
        ...Object.fromEntries(storyboardIds.map(id => [id, 0])),
      }))
      await fetchDataRef.current?.(true)
      const timer = setTimeout(() => pollGenerateAllStatus(res.task_uuid, storyboardIds), 3000)
      storyboardIds.forEach(id => {
        pollTimersRef.current[id] = timer
      })
    } catch (err) {
      console.error('Failed to generate all storyboard videos:', err)
      await handleRequestError(err, t('video_generate_failed'))
    }
  }, [
    canGenerateAllStoryboards,
    generateAllCandidateStoryboards,
    handleBillingError,
    handleInsufficientCredits,
    handleKnownCreditShortfall,
    handleRequestError,
    pollGenerateAllStatus,
    scriptId,
    t,
    taskId,
  ])

  // Handle play click — trigger video generation if no video, else handled by preview component
  const handlePlayClick = useCallback(() => {
    handleGenerateVideo()
  }, [handleGenerateVideo])

  // Format subtitle with last update time
  const subtitle = currentStoryboard?.update_time
    ? `修改于  ${new Date(currentStoryboard.update_time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : undefined

  return (
    <div
      data-wegent-panel
      data-testid="video-storyboard-panel"
      className={
        embedded
          ? `flex flex-col h-full w-full max-w-full pb-[10px] overflow-hidden rounded-t-[10px] ${videoThemeStyles.panel} ${readOnly ? 'rounded-[24px]' : ''}`
          : `fixed right-0 top-[56px] bottom-[10px] w-[720px] z-50 flex flex-col pb-[10px] ${videoThemeStyles.panel}`
      }
      style={
        embedded
          ? undefined
          : {
              borderRadius: '0 4px 4px 0',
              boxShadow: '0 4px 8.75px 0 rgba(182, 182, 182, 0.25)',
            }
      }
    >
      {/* Header — 56px, same style as EntityPanel */}
      <div className="flex-shrink-0 h-[56px] flex items-center px-3.5 sm:px-5 bg-white">
        {/* Title area */}
        <div className="flex-1 min-w-0">
          <h2
            className="text-sm text-text-primary truncate"
            style={{ fontFamily: "'PingFang SC', sans-serif" }}
          >
            {scriptState.loading ? (
              <span className="text-text-muted">{t('loading')}</span>
            ) : (
              scriptState.title || t('storyboard_management')
            )}
          </h2>
          {subtitle && (
            <p
              className="text-[10px] text-text-muted leading-[1.8]"
              style={{ fontFamily: "'PingFang SC', sans-serif" }}
            >
              {subtitle}
            </p>
          )}
        </div>

        {/* Right side: Action buttons + Close */}
        <div className="flex items-center gap-4">
          {!readOnly && (
            <div className="flex h-8 items-center gap-3">
              <button
                className="inline-flex h-8 w-[108px] items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-[14px] font-normal leading-5 text-text-primary transition-opacity"
                disabled={isGenerateAllDisabled}
                style={{
                  fontFamily: "'PingFang SC', sans-serif",
                  backgroundColor: '#F5F5F5',
                  opacity: isGenerateAllDisabled ? 0.5 : 1,
                  cursor: isGenerateAllDisabled ? 'default' : 'pointer',
                }}
                onClick={() => void handleGenerateAll()}
                data-testid="video-storyboard-generate-all"
              >
                生成全部分镜
              </button>
              {!isMobile ? (
                <>
                  <button
                    className="inline-flex h-8 w-[88px] items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-[14px] font-normal leading-5 text-text-primary transition-opacity"
                    disabled={!canComposeStoryboardVideo}
                    style={{
                      fontFamily: "'PingFang SC', sans-serif",
                      backgroundColor: '#F5F5F5',
                      opacity: canComposeStoryboardVideo ? 1 : 0.5,
                      cursor: canComposeStoryboardVideo ? 'pointer' : 'default',
                    }}
                    onClick={() => {
                      fetchData()
                      fetchScriptTitle()
                      setIsCompositionEditorOpen(true)
                    }}
                    data-testid="video-storyboard-open-composition"
                  >
                    分镜剪辑
                  </button>
                  {canShowGenerateFinalVideoButton && (
                    <button
                      className="inline-flex h-8 w-[108px] items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-[14px] font-medium leading-5 text-[#FF8200] transition-opacity"
                      disabled={isGenerateFinalVideoDisabled}
                      style={{
                        fontFamily: "'PingFang SC', sans-serif",
                        backgroundColor: 'rgba(255, 130, 0, 0.1)',
                        opacity: isGenerateFinalVideoDisabled ? 0.5 : 1,
                        cursor: isGenerateFinalVideoDisabled ? 'default' : 'pointer',
                      }}
                      onClick={() => void onGenerateFinalVideo?.()}
                    >
                      {isGeneratingFinalVideo ? '发送中...' : '生成最终视频'}
                    </button>
                  )}
                </>
              ) : null}
            </div>
          )}
          {/* Close button */}
          <PanelCloseButton onClose={onClose} testId="video-storyboard-close" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-scroll">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
            <p className="text-sm text-text-muted">{t('loading_storyboards')}</p>
          </div>
        ) : storyboards.length > 0 ? (
          <>
            {currentStoryboard && (
              <div
                className="relative mb-3 flex w-full items-center justify-center"
                style={{
                  marginTop: '16px',
                }}
              >
                <div
                  className="relative flex min-h-[24px] items-center justify-center"
                  style={{ width: '100%' }}
                >
                  <h3
                    className="text-[15px] text-text-primary leading-[1.53] text-center"
                    style={{ fontFamily: "'PingFang TC', sans-serif" }}
                  >
                    {`${t('video')}${(currentStoryboard.sequence_number ?? 0) + 1}`}
                  </h3>
                  <div
                    className="absolute top-1/2 flex -translate-y-1/2 items-center"
                    style={{ right: isMobile ? '14px' : '24px' }}
                  >
                    {!readOnly && (currentStoryboard.video_versions?.length ?? 0) > 0 ? (
                      <StoryboardVersionSelector
                        currentVersion={currentVersion}
                        versions={currentStoryboard.video_versions ?? []}
                        onChange={clipId => handleVersionChange(currentStoryboard.id, clipId)}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            )}
            <CarouselView
              title={`${t('video')}${(currentStoryboard?.sequence_number ?? 0) + 1}`}
              hideTitleBar={true}
              currentIndex={currentIndex}
              totalCount={storyboards.length}
              isLoading={false}
              mediaType="video"
              ratio={ratio}
              isRegenerating={isVideoGenerating}
              isRegenerateDisabled={hasAnyGeneratingVersion}
              isEditing={isEditing}
              editDescription={editDescription}
              thumbnailItems={flattenedItems}
              description={currentDescription}
              showMaxLength={true}
              onPrev={prev}
              onNext={next}
              onGoTo={goTo}
              onEditStart={handleEditStart}
              onEditCancel={handleEditCancel}
              onEditSave={handleEditSave}
              onEditDescriptionChange={setEditDescription}
              onEditVoiceProfileChange={() => {}}
              onRegenerate={handleRegenerate}
              readOnly={readOnly || isPendingVideoGeneration}
              renderMedia={() => {
                const ratioDimensions = getRatioDimensions(ratio)
                // Responsive image sizing: use smaller dimensions on mobile
                const imageWidth = isMobile
                  ? Math.min(ratioDimensions.imageWidth, 280)
                  : ratioDimensions.imageWidth
                const imageHeight = isMobile
                  ? Math.round((280 / ratioDimensions.imageWidth) * ratioDimensions.imageHeight)
                  : ratioDimensions.imageHeight
                return (
                  <StoryboardVideoPreview
                    storyboard={previewStoryboard!}
                    isVideoGenerating={isVideoGenerating}
                    isPendingVideoGeneration={isPendingVideoGeneration}
                    onPlayClick={handlePlayClick}
                    imageWidth={imageWidth}
                    imageHeight={imageHeight}
                    trimStart={currentVersion?.trim_start}
                    trimEnd={currentVersion?.trim_end}
                    readOnly={readOnly}
                    shareToken={shareToken}
                  />
                )
              }}
            />
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <p className="text-sm text-text-muted">{t('no_storyboards')}</p>
          </div>
        )}
      </div>

      {/* Composition Editor Dialog */}
      <Dialog
        open={isCompositionEditorOpen}
        onOpenChange={open => {
          if (!open && beforeCloseRef.current?.()) return
          setIsCompositionEditorOpen(open)
        }}
      >
        <DialogContent
          className="z-[2147483640] h-screen w-screen max-w-none gap-0 border-0 p-0 top-1/2 rounded-none sm:rounded-none"
          hideCloseButton
          onEscapeKeyDown={e => {
            e.stopPropagation()
          }}
        >
          <DialogTitle className="sr-only">分镜剪辑</DialogTitle>
          {isCompositionEditorOpen && (
            <CompositionEditor
              scriptId={scriptId}
              taskId={taskId}
              storyboards={storyboards.filter(sb => {
                const version = getEffectiveVersion(sb, selectedVersionMap[sb.id])
                return version?.generation_status === 3
              })}
              selectedVersionMap={selectedVersionMap}
              bgm={scriptState.bgm}
              bgmEnabled={scriptState.bgmEnabled}
              subtitleEnabled={scriptState.subtitleEnabled}
              finalVideoCover={scriptState.finalVideoCover}
              onFinalVideoCoverChange={cover => {
                setScriptState(prev => ({ ...prev, finalVideoCover: cover }))
              }}
              shareToken={shareToken}
              ratio={ratio}
              onClose={() => {
                setIsCompositionEditorOpen(false)
                fetchData()
                fetchScriptTitle()
              }}
              onRenderFinalVideo={
                onGenerateFinalVideo
                  ? async () => {
                      setIsCompositionEditorOpen(false)
                      await onGenerateFinalVideo()
                    }
                  : undefined
              }
              onSaveSuccess={res => {
                toast({ description: res.message })
              }}
              readOnly={readOnly}
              beforeCloseRef={beforeCloseRef}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
