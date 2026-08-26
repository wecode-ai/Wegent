// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * CompositionEditor - Main container for the composition editing workspace.
 * Draft is built from storyboard data each time the editor opens (no backend draft storage).
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { Storyboard } from '../storyboard/types'
import type {
  CompositionClip,
  CompositionSubtitle,
  CompositionBgm,
  VideoCompositionDraft,
  SaveCompositionResponse,
} from './types'
import {
  buildDefaultClips,
  buildDefaultSubtitles,
  buildSubtitlesFromSrt,
  getClipGlobalTimeRange,
  getClipEffectiveDuration,
  getClipSourceDuration,
  getClipGlobalStartTime,
  getNextBgmIdx,
  buildSrt,
  saveBgmTask,
  removeBgmTask,
  loadBgmTasks,
  saveSubTask,
  removeSubTask,
  loadSubTasks,
} from './utils'
import { compositionApis } from './api'
import { storyboardApis } from '../storyboard/api'
import { CompositionPreview } from './CompositionPreview'
import { ClipTimeline } from './ClipTimeline'
import { ClipInspector, type InspectorTab } from './ClipInspector'
import { FinalCoverPickerDialog } from './FinalCoverPickerDialog'
import { useToast } from '@/hooks/use-toast'
import type { FinalVideoCover } from '../script/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { scriptApi } from '../script/api'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from '../aigc_video/mediaUrls'

interface CompositionEditorProps {
  scriptId: number
  taskId: number
  storyboards: Storyboard[]
  selectedVersionMap: Record<number, number>
  bgm?: CompositionBgm[]
  bgmEnabled?: boolean
  subtitleEnabled?: boolean
  finalVideoCover?: FinalVideoCover | null
  ratio?: string
  onClose: () => void
  onRenderFinalVideo?: (draftId: number) => Promise<void>
  onSaveSuccess?: (res: SaveCompositionResponse) => void
  onFinalVideoCoverChange?: (cover: FinalVideoCover | null) => void
  shareToken?: string
  readOnly?: boolean
  beforeCloseRef?: { current: (() => boolean) | null }
}

export function CompositionEditor({
  scriptId,
  taskId,
  storyboards,
  selectedVersionMap,
  bgm = [],
  bgmEnabled: initialBgmEnabled = true,
  subtitleEnabled: initialSubtitleEnabled = true,
  finalVideoCover = null,
  ratio,
  onClose,
  onRenderFinalVideo,
  onSaveSuccess,
  onFinalVideoCoverChange,
  shareToken,
  readOnly = false,
  beforeCloseRef,
}: CompositionEditorProps) {
  const { toast } = useToast()

  // Derive clip video URL, cover URL, and duration maps from ALL storyboard versions.
  // Including every version allows immediate resolution after a local version switch.
  const clipVideoUrlMap = useMemo(() => {
    const map: Record<number, string> = {}
    for (const sb of storyboards) {
      for (const v of sb.video_versions ?? []) {
        if (v.model_video_url) map[v.id] = getAigcVideoPlaybackUrl(v.model_video_url)
      }
      if (sb.video_clip?.model_video_url) {
        map[sb.video_clip.id] = getAigcVideoPlaybackUrl(sb.video_clip.model_video_url)
      }
    }
    return map
  }, [storyboards])

  const clipCoverUrlMap = useMemo(() => {
    const map: Record<number, string> = {}
    for (const sb of storyboards) {
      for (const v of sb.video_versions ?? []) {
        if (v.video_cover_url) map[v.id] = getAigcVideoImageUrl(v.video_cover_url) || ''
      }
      if (sb.video_clip?.video_cover_url) {
        map[sb.video_clip.id] = getAigcVideoImageUrl(sb.video_clip.video_cover_url) || ''
      }
    }
    return map
  }, [storyboards])

  const clipDurationMap = useMemo(() => {
    const map: Record<number, number> = {}
    for (const sb of storyboards) {
      for (const v of sb.video_versions ?? []) {
        if (v.duration) map[v.id] = v.duration
        else if (v.id) map[v.id] = 15
      }
      if (sb.video_clip) {
        if (sb.video_clip.duration) map[sb.video_clip.id] = sb.video_clip.duration
        else map[sb.video_clip.id] = 15
      }
    }
    return map
  }, [storyboards])

  const storyboardInfoMap = useMemo(() => {
    const map: Record<
      number,
      {
        visual?: string
        ff_desc?: string
        shots_prompt?: string
        dialogue?: string
        mood?: string
        camera_notes?: string
      }
    > = {}
    for (const sb of storyboards) {
      map[sb.id] = {
        visual: sb.visual || undefined,
        ff_desc: sb.ff_desc || undefined,
        shots_prompt: sb.shots_prompt || undefined,
        dialogue: sb.dialogue || undefined,
        mood: sb.mood || undefined,
        camera_notes: sb.camera_notes || undefined,
      }
    }
    return map
  }, [storyboards])

  // Build draft directly from storyboard data (no backend draft storage)
  const initialDraft = useMemo<VideoCompositionDraft>(() => {
    const clips = buildDefaultClips(storyboards, selectedVersionMap)
    const subtitles = buildDefaultSubtitles(storyboards, clips, clipDurationMap)

    return {
      id: Date.now(),
      script_id: scriptId,
      task_id: taskId,
      source_revision: '',
      status: 'draft',
      clips,
      subtitles,
      music: { mode: 'none', volume: 0 },
      bgm: bgm.map(b => {
        const isExisting = Boolean(b.audio_url) && !b.status
        return {
          ...b,
          volume: b.volume ?? 0.15,
          status: b.status || (isExisting ? 'success' : 'draft'),
        }
      }),
      bgmEnabled: initialBgmEnabled,
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString(),
    }
  }, [scriptId, taskId, storyboards, selectedVersionMap, clipDurationMap, bgm])

  const [isUploadingCover, setIsUploadingCover] = useState(false)

  // Draft state
  const [draft, setDraft] = useState<VideoCompositionDraft>(initialDraft)

  // Selection state
  const [selectedClipIndex, setSelectedClipIndex] = useState<number | null>(0)
  const [manuallyEditedSubtitleIds, setManuallyEditedSubtitleIds] = useState<Set<string>>(
    () => new Set()
  )
  const [regeneratingSubtitleStoryboardIds, setRegeneratingSubtitleStoryboardIds] = useState<
    Set<number>
  >(() => new Set())
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('clip')
  // Independent clip index for subtitle tab — synced from external changes
  const [subtitleClipIndex, setSubtitleClipIndex] = useState<number>(0)
  // Track timeline subtitle selection to suppress subtitleClipIndex sync during playback
  const [timelineSelectedSubtitleId, setTimelineSelectedSubtitleId] = useState<string | null>(null)
  // Track timeline BGM selection for inspector focus sync
  const [selectedBgmIdx, setSelectedBgmIdx] = useState<number | null>(null)
  // Inspector clip index: defaults to 0, synced from selectedClipIndex when it changes,
  // but kept when deselected so the inspector panel still shows content
  const [inspectorClipIndex, setInspectorClipIndex] = useState<number>(0)

  // Sync inspectorClipIndex from timeline selection changes
  useEffect(() => {
    if (selectedClipIndex != null) {
      setInspectorClipIndex(selectedClipIndex)
    }
  }, [selectedClipIndex])

  // Global deselection: clicking outside timeline selectable items clears all selections
  useEffect(() => {
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Ignore clicks on interactive elements (inputs, buttons, etc.)
      if (
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('button') ||
        target.closest('a') ||
        target.closest('select') ||
        target.closest('[role="button"]') ||
        target.closest('[role="tab"]') ||
        target.closest('[role="menuitem"]')
      ) {
        return
      }
      // Ignore clicks on timeline selectable items (clips, subtitles, bgm)
      if (target.closest('[data-timeline-selectable]')) {
        return
      }
      // Ignore clicks on inspector cards (clip, subtitle, bgm items)
      if (target.closest('[data-inspector-card]')) {
        return
      }
      // Otherwise deselect everything
      setSelectedClipIndex(null)
      setTimelineSelectedSubtitleId(null)
      setSelectedBgmIdx(null)
    }
    document.addEventListener('mousedown', handleDocMouseDown)
    return () => document.removeEventListener('mousedown', handleDocMouseDown)
  }, [])

  // Sync subtitleClipIndex when selectedClipIndex changes from external sources (playback, timeline)
  // Skip sync when a subtitle is actively selected in the timeline
  useEffect(() => {
    if (selectedClipIndex != null && timelineSelectedSubtitleId == null) {
      setSubtitleClipIndex(selectedClipIndex)
    }
  }, [selectedClipIndex, timelineSelectedSubtitleId])

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentGlobalTime, setCurrentGlobalTime] = useState(0)
  const [previewSeekTime, setPreviewSeekTime] = useState<number | null>(null)
  const [subtitlesVisible, setSubtitlesVisible] = useState(initialSubtitleEnabled)
  const [savedFinalVideoCover, setSavedFinalVideoCover] = useState<FinalVideoCover | null>(
    finalVideoCover
  )
  const [localFinalVideoCoverPreviewUrl, setLocalFinalVideoCoverPreviewUrl] = useState<
    string | null
  >(finalVideoCover?.cover_url ?? null)

  useEffect(() => {
    setSavedFinalVideoCover(finalVideoCover)
    if (finalVideoCover?.cover_url) {
      setLocalFinalVideoCoverPreviewUrl(null)
    }
  }, [finalVideoCover])

  useEffect(() => {
    if (!savedFinalVideoCover?.generation_status) return
    if (
      savedFinalVideoCover.generation_status !== 'pending' &&
      savedFinalVideoCover.generation_status !== 'processing'
    ) {
      if (savedFinalVideoCover.cover_url) {
        setLocalFinalVideoCoverPreviewUrl(null)
      }
      return
    }

    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const script = await scriptApi.getScript(scriptId, shareToken ? { shareToken } : undefined)
        if (cancelled) return
        const nextCover = script.final_video_cover ?? null
        if (!nextCover) return
        setSavedFinalVideoCover(nextCover)
        onFinalVideoCoverChange?.(nextCover)
        if (nextCover.cover_url) {
          setLocalFinalVideoCoverPreviewUrl(null)
        }
      } catch (error) {
        console.error('Failed to poll final cover status:', error)
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [onFinalVideoCoverChange, savedFinalVideoCover, scriptId, shareToken])

  // Save loading state
  const [isSaving, setIsSaving] = useState(false)
  const [isCoverPickerOpen, setIsCoverPickerOpen] = useState(false)
  // Version counter bumped after each save to force hasUnsavedChanges recomputation
  const [saveVersion, setSaveVersion] = useState(0)

  // Snapshot of initial subtitle visibility to detect changes
  const initialSubtitlesVisibleRef = useRef(initialSubtitleEnabled)
  useEffect(() => {
    initialSubtitlesVisibleRef.current = initialSubtitleEnabled
  }, [initialSubtitleEnabled])

  // Undo/redo history
  const [historyPast, setHistoryPast] = useState<VideoCompositionDraft[]>([])
  const [historyFuture, setHistoryFuture] = useState<VideoCompositionDraft[]>([])

  // Unsaved changes confirmation dialog
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const pendingCloseRef = useRef<(() => void) | null>(null)

  // Snapshot of initial draft to detect changes
  const initialDraftRef = useRef<VideoCompositionDraft>(initialDraft)
  useEffect(() => {
    initialDraftRef.current = initialDraft
  }, [initialDraft])

  // Detect unsaved changes by comparing draft against initial
  const hasUnsavedChanges = useMemo(() => {
    const initial = initialDraftRef.current
    if (draft.clips.length !== initial.clips.length) return true
    for (let i = 0; i < draft.clips.length; i++) {
      const a = draft.clips[i]
      const b = initial.clips[i]
      if (!b) return true
      if (
        a.clip_id !== b.clip_id ||
        a.trim_start !== b.trim_start ||
        a.trim_end !== b.trim_end ||
        a.enabled !== b.enabled ||
        a.volume !== b.volume
      )
        return true
    }
    if (draft.subtitles.length !== initial.subtitles.length) return true
    const subKey = (s: CompositionSubtitle) => `${s.id}:${s.start}:${s.end}:${s.text}:${s.enabled}`
    const draftSubKeys = new Set(draft.subtitles.map(subKey))
    const initSubKeys = new Set(initial.subtitles.map(subKey))
    if (draftSubKeys.size !== initSubKeys.size) return true
    for (const key of draftSubKeys) {
      if (!initSubKeys.has(key)) return true
    }
    if (draft.bgm.length !== initial.bgm.length) return true
    for (let i = 0; i < draft.bgm.length; i++) {
      const a = draft.bgm[i]
      const b = initial.bgm[i]
      if (!b) return true
      if (
        a.start_time !== b.start_time ||
        a.end_time !== b.end_time ||
        a.volume !== b.volume ||
        a.prompt !== b.prompt ||
        a.audio_url !== b.audio_url
      )
        return true
    }
    if (draft.bgmEnabled !== initial.bgmEnabled) return true
    if (subtitlesVisible !== initialSubtitlesVisibleRef.current) return true
    return false
  }, [draft, subtitlesVisible, saveVersion])

  // Expose hasUnsavedChanges to parent for dialog close check
  useEffect(() => {
    if (beforeCloseRef) {
      beforeCloseRef.current = () => hasUnsavedChanges
    }
    return () => {
      if (beforeCloseRef) {
        beforeCloseRef.current = null
      }
    }
  }, [beforeCloseRef, hasUnsavedChanges])

  // BGM regeneration polling refs
  const bgmPollTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  // Subtitle regeneration polling refs (keyed by storyboard_id)
  const subPollTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  // Current clips and subtitles from draft
  const clips = draft.clips
  const subtitles = draft.subtitles

  // Auto-switch subtitle clip when a timeline subtitle is selected
  useEffect(() => {
    if (timelineSelectedSubtitleId == null) return
    const sub = subtitles.find(s => s.id === timelineSelectedSubtitleId)
    if (!sub) return
    const idx = clips.findIndex(c => c.storyboard_id === sub.storyboard_id)
    if (idx !== -1) {
      setSubtitleClipIndex(idx)
    }
  }, [timelineSelectedSubtitleId, subtitles, clips])

  // Inspector clip data (persisted even when deselected so panel still shows content)
  const inspectorClip = clips[inspectorClipIndex] ?? null
  const inspectorClipOriginalDuration = inspectorClip
    ? getClipSourceDuration(inspectorClip, clipDurationMap)
    : 0

  // --- Handlers ---

  // Save current draft to history before a mutation
  const saveToHistory = useCallback(() => {
    setHistoryPast(prev => [...prev.slice(-49), draft])
    setHistoryFuture([])
  }, [draft])

  const handleUndo = useCallback(() => {
    if (historyPast.length === 0) return
    const previous = historyPast[historyPast.length - 1]
    setHistoryFuture(prev => [draft, ...prev])
    setHistoryPast(prev => prev.slice(0, -1))
    setDraft(previous)
  }, [historyPast, draft])

  const handleRedo = useCallback(() => {
    if (historyFuture.length === 0) return
    const next = historyFuture[0]
    setHistoryPast(prev => [...prev.slice(-49), draft])
    setHistoryFuture(prev => prev.slice(1))
    setDraft(next)
  }, [historyFuture, draft])

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (showUnsavedDialog) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleUndo, handleRedo, showUnsavedDialog])

  // Handle close with unsaved-changes check
  const handleRequestClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowUnsavedDialog(true)
      pendingCloseRef.current = onClose
    } else {
      onClose()
    }
  }, [hasUnsavedChanges, onClose])

  const handleConfirmDiscard = useCallback(() => {
    setShowUnsavedDialog(false)
    pendingCloseRef.current?.()
    pendingCloseRef.current = null
  }, [])

  const handleCancelDiscard = useCallback(() => {
    setShowUnsavedDialog(false)
    pendingCloseRef.current = null
  }, [])

  const rebuildSubtitleTimes = useCallback(
    (updatedClips: CompositionClip[], currentSubtitles: CompositionSubtitle[]) => {
      // Rebuild from scratch using storyboard SRT data, preserving manual edits
      const defaults = buildDefaultSubtitles(storyboards, updatedClips, clipDurationMap)
      const defaultById = new Map(defaults.map(s => [s.id, s]))

      return currentSubtitles.map(sub => {
        if (manuallyEditedSubtitleIds.has(sub.id)) return sub
        const defaultSub = defaultById.get(sub.id)
        if (defaultSub) {
          return {
            ...sub,
            start: defaultSub.start,
            end: defaultSub.end,
            clip_local_start: defaultSub.clip_local_start,
            clip_local_end: defaultSub.clip_local_end,
          }
        }
        return sub
      })
    },
    [clipDurationMap, manuallyEditedSubtitleIds, storyboards]
  )

  const handleTrimChange = useCallback(
    (trimStart: number, trimEnd: number | null) => {
      const targetIndex = selectedClipIndex ?? inspectorClipIndex
      if (targetIndex === null) return
      saveToHistory()
      setDraft(prev => {
        const updatedClips = prev.clips.map((clip, i) =>
          i === targetIndex ? { ...clip, trim_start: trimStart, trim_end: trimEnd } : clip
        )
        return {
          ...prev,
          clips: updatedClips,
          subtitles: rebuildSubtitleTimes(updatedClips, prev.subtitles),
        }
      })
    },
    [rebuildSubtitleTimes, selectedClipIndex, inspectorClipIndex, saveToHistory]
  )

  const handleTimelineTrimChange = useCallback(
    (clipIndex: number, trimStart: number, trimEnd: number | null) => {
      setSelectedClipIndex(clipIndex)
      saveToHistory()
      setDraft(prev => {
        const updatedClips = prev.clips.map((clip, i) =>
          i === clipIndex ? { ...clip, trim_start: trimStart, trim_end: trimEnd } : clip
        )
        return {
          ...prev,
          clips: updatedClips,
          subtitles: rebuildSubtitleTimes(updatedClips, prev.subtitles),
        }
      })
    },
    [rebuildSubtitleTimes, saveToHistory]
  )

  const handleClipVolumeChange = useCallback(
    (volume: number) => {
      const targetIndex = selectedClipIndex ?? inspectorClipIndex
      if (targetIndex === null) return
      saveToHistory()
      setDraft(prev => ({
        ...prev,
        clips: prev.clips.map((clip, i) => (i === targetIndex ? { ...clip, volume } : clip)),
      }))
    },
    [selectedClipIndex, inspectorClipIndex, saveToHistory]
  )

  const handleClipEnabledChange = useCallback(
    (enabled: boolean) => {
      const targetIndex = selectedClipIndex ?? inspectorClipIndex
      if (targetIndex === null) return
      saveToHistory()
      setDraft(prev => {
        const updatedClips = prev.clips.map((clip, i) =>
          i === targetIndex ? { ...clip, enabled } : clip
        )
        return {
          ...prev,
          clips: updatedClips,
          subtitles: rebuildSubtitleTimes(updatedClips, prev.subtitles),
        }
      })
    },
    [rebuildSubtitleTimes, selectedClipIndex, inspectorClipIndex, saveToHistory]
  )

  const handleSubtitleChange = useCallback(
    (subtitleId: string, updates: Partial<CompositionSubtitle>) => {
      if (
        'start' in updates ||
        'end' in updates ||
        'clip_local_start' in updates ||
        'clip_local_end' in updates
      ) {
        setManuallyEditedSubtitleIds(prev => new Set(prev).add(subtitleId))
      }
      saveToHistory()
      setDraft(prev => ({
        ...prev,
        subtitles: prev.subtitles.map(sub =>
          sub.id === subtitleId ? { ...sub, ...updates } : sub
        ),
      }))
    },
    [saveToHistory]
  )

  const handleSubtitleTimeChange = useCallback(
    (subtitleId: string, newStart: number, newEnd: number) => {
      const sub = draft.subtitles.find(s => s.id === subtitleId)
      if (!sub || sub.storyboard_id == null) return
      const clipIndex = draft.clips.findIndex(c => c.storyboard_id === sub.storyboard_id)
      if (clipIndex === -1) return
      const range = getClipGlobalTimeRange(clipIndex, draft.clips, clipDurationMap)
      const clip = draft.clips[clipIndex]

      // Update global times and corresponding clip-local times
      const clipLocalStart = newStart - range.start + clip.trim_start
      const clipLocalEnd = newEnd - range.start + clip.trim_start

      handleSubtitleChange(subtitleId, {
        start: newStart,
        end: newEnd,
        clip_local_start: clipLocalStart,
        clip_local_end: clipLocalEnd,
      })
    },
    [draft.subtitles, draft.clips, clipDurationMap, handleSubtitleChange]
  )

  const handleSubtitleAdd = useCallback(() => {
    const targetClip = clips[subtitleClipIndex] ?? null
    if (!targetClip) return
    const range = getClipGlobalTimeRange(subtitleClipIndex, draft.clips, clipDurationMap)
    const effectiveDuration = getClipEffectiveDuration(
      targetClip,
      getClipSourceDuration(targetClip, clipDurationMap)
    )
    const newSub: CompositionSubtitle = {
      id: `sub-${Date.now()}`,
      storyboard_id: targetClip.storyboard_id,
      start: range.start,
      end: range.end || range.start + effectiveDuration,
      clip_local_start: 0,
      clip_local_end: effectiveDuration,
      text: '',
      enabled: true,
    }
    saveToHistory()
    setDraft(prev => ({ ...prev, subtitles: [...prev.subtitles, newSub] }))
  }, [clipDurationMap, draft.clips, subtitleClipIndex, clips, saveToHistory])

  const handleSubtitleDelete = useCallback(
    (subtitleId: string) => {
      saveToHistory()
      setDraft(prev => ({
        ...prev,
        subtitles: prev.subtitles.filter(sub => sub.id !== subtitleId),
      }))
    },
    [saveToHistory]
  )

  // Handle BGM enabled toggle
  const handleBgmEnabledChange = useCallback(
    (enabled: boolean) => {
      saveToHistory()
      setDraft(prev => ({ ...prev, bgmEnabled: enabled }))
    },
    [saveToHistory]
  )

  // Handle individual BGM volume change
  const handleBgmVolumeChange = useCallback(
    (idx: number, volume: number) => {
      saveToHistory()
      setDraft(prev => ({
        ...prev,
        bgm: prev.bgm.map(b => (b.idx === idx ? { ...b, volume } : b)),
      }))
    },
    [saveToHistory]
  )

  // Handle individual BGM prompt change
  const handleBgmPromptChange = useCallback(
    (idx: number, prompt: string) => {
      saveToHistory()
      setDraft(prev => ({
        ...prev,
        bgm: prev.bgm.map(b => (b.idx === idx ? { ...b, prompt } : b)),
      }))
    },
    [saveToHistory]
  )

  // Handle BGM delete
  const handleBgmDelete = useCallback(
    (idx: number) => {
      saveToHistory()
      setDraft(prev => ({
        ...prev,
        bgm: prev.bgm.filter(b => b.idx !== idx),
      }))
      if (bgmPollTimersRef.current[idx]) {
        clearTimeout(bgmPollTimersRef.current[idx])
        delete bgmPollTimersRef.current[idx]
      }
      removeBgmTask(scriptId, idx)
    },
    [scriptId, saveToHistory]
  )

  // Handle BGM add
  const handleBgmAdd = useCallback(() => {
    saveToHistory()
    setDraft(prev => {
      const lastEnd = prev.bgm.length > 0 ? Math.max(...prev.bgm.map(b => b.end_time)) : 0
      const newBgm: CompositionBgm = {
        idx: getNextBgmIdx(prev.bgm),
        start_time: lastEnd,
        end_time: lastEnd + 10,
        mood: '',
        style: '',
        prompt: '',
        status: 'draft',
        audio_url: '',
        media_id: '',
        volume: 0.15,
      }
      return { ...prev, bgm: [...prev.bgm, newBgm] }
    })
  }, [saveToHistory])

  // Handle BGM time change
  const handleBgmTimeChange = useCallback(
    (idx: number, field: 'start_time' | 'end_time', value: number) => {
      saveToHistory()
      setDraft(prev => {
        const updated = prev.bgm.map(b => (b.idx === idx ? { ...b, [field]: value } : b))
        return { ...prev, bgm: updated }
      })
    },
    [saveToHistory]
  )

  // Poll music generation status
  const pollBgmStatus = useCallback(
    async (idx: number, taskUuid: string) => {
      try {
        const status = await compositionApis.getMusicTaskStatus(taskUuid)
        const wb = status.wb_data
        const taskStatus = wb.status || status.status
        const mediaId = wb.media_id || status.result?.media_id
        const audioUrl = wb.audio_url || status.result?.audio_url
        if (taskStatus === 'completed' && mediaId && audioUrl) {
          setDraft(prev => {
            setHistoryPast(h => [...h.slice(-49), prev])
            setHistoryFuture([])
            return {
              ...prev,
              bgm: prev.bgm.map(b =>
                b.idx === idx
                  ? {
                      ...b,
                      status: 'success',
                      audio_url: audioUrl,
                      media_id: mediaId,
                      task_uuid: undefined,
                    }
                  : b
              ),
            }
          })
          removeBgmTask(scriptId, idx)
          delete bgmPollTimersRef.current[idx]
        } else if (taskStatus === 'failed') {
          setDraft(prev => {
            setHistoryPast(h => [...h.slice(-49), prev])
            setHistoryFuture([])
            return {
              ...prev,
              bgm: prev.bgm.map(b =>
                b.idx === idx
                  ? {
                      ...b,
                      status: b.audio_url ? 'success' : 'draft',
                      task_uuid: undefined,
                    }
                  : b
              ),
            }
          })
          removeBgmTask(scriptId, idx)
          delete bgmPollTimersRef.current[idx]
        } else {
          bgmPollTimersRef.current[idx] = setTimeout(() => pollBgmStatus(idx, taskUuid), 3000)
        }
      } catch (err) {
        console.error('Failed to poll BGM status:', err)
        bgmPollTimersRef.current[idx] = setTimeout(() => pollBgmStatus(idx, taskUuid), 5000)
      }
    },
    [scriptId]
  )

  // Handle BGM regenerate
  const handleBgmRegenerate = useCallback(
    async (idx: number) => {
      const segment = draft.bgm.find(b => b.idx === idx)
      if (!segment) return

      const duration = segment.end_time - segment.start_time
      if (duration <= 0) {
        console.error('BGM duration must be greater than 0')
        return
      }

      if (bgmPollTimersRef.current[idx]) {
        clearTimeout(bgmPollTimersRef.current[idx])
        delete bgmPollTimersRef.current[idx]
      }

      saveToHistory()
      setDraft(prev => ({
        ...prev,
        bgm: prev.bgm.map(b => (b.idx === idx ? { ...b, status: 'pending' } : b)),
      }))

      try {
        const res = await compositionApis.generateMusic({
          prompt: segment.prompt,
          duration,
        })
        setDraft(prev => ({
          ...prev,
          bgm: prev.bgm.map(b => (b.idx === idx ? { ...b, task_uuid: res.task_uuid } : b)),
        }))
        saveBgmTask(scriptId, idx, res.task_uuid)
        bgmPollTimersRef.current[idx] = setTimeout(() => pollBgmStatus(idx, res.task_uuid), 3000)
      } catch (err) {
        console.error('Failed to regenerate BGM:', err)
        setDraft(prev => ({
          ...prev,
          bgm: prev.bgm.map(b =>
            b.idx === idx
              ? { ...b, status: b.audio_url ? 'success' : 'draft', task_uuid: undefined }
              : b
          ),
        }))
      }
    },
    [draft.bgm, pollBgmStatus, saveToHistory]
  )

  // Cleanup BGM poll timers on unmount
  useEffect(() => {
    return () => {
      Object.values(bgmPollTimersRef.current).forEach(clearTimeout)
    }
  }, [])

  // Resume BGM polling for tasks cached in localStorage (survives page navigation)
  useEffect(() => {
    const cachedTasks = loadBgmTasks(scriptId)
    if (cachedTasks.length === 0) return

    setDraft(prev => {
      const updatedBgm = prev.bgm.map(b => {
        const cached = cachedTasks.find(t => t.idx === b.idx)
        if (!cached) return b
        return { ...b, status: 'pending' as const, task_uuid: cached.task_uuid }
      })
      return { ...prev, bgm: updatedBgm }
    })

    // Start polling after a short delay to let draft state settle
    const timer = setTimeout(() => {
      for (const task of cachedTasks) {
        pollBgmStatus(task.idx, task.task_uuid)
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [scriptId, pollBgmStatus])

  // --- Subtitle regeneration ---

  // Poll subtitle regeneration task status
  const pollSubtitleStatus = useCallback(
    async (storyboardId: number, clipId: number, taskUuid: string) => {
      try {
        const res = await compositionApis.getSubtitleTaskStatus(taskUuid)
        if (res.status === 'completed' && res.result?.srt_content) {
          const srtContent = res.result.srt_content
          setDraft(prev => {
            const clip = prev.clips.find(c => c.clip_id === clipId)
            if (!clip) return prev
            const globalOffset = prev.clips
              .slice(0, prev.clips.indexOf(clip))
              .filter(c => c.enabled)
              .reduce(
                (sum, c) =>
                  sum + getClipEffectiveDuration(c, getClipSourceDuration(c, clipDurationMap)),
                0
              )
            const newSubs = buildSubtitlesFromSrt(srtContent, storyboardId, globalOffset)
            const otherSubs = prev.subtitles.filter(s => s.storyboard_id !== storyboardId)
            setHistoryPast(h => [...h.slice(-49), prev])
            setHistoryFuture([])
            return { ...prev, subtitles: [...otherSubs, ...newSubs] }
          })
          removeSubTask(scriptId, storyboardId)
          delete subPollTimersRef.current[storyboardId]
          setRegeneratingSubtitleStoryboardIds(prev => {
            const next = new Set(prev)
            next.delete(storyboardId)
            return next
          })
        } else if (res.status === 'failed') {
          setDraft(prev => {
            setHistoryPast(h => [...h.slice(-49), prev])
            setHistoryFuture([])
            return {
              ...prev,
              subtitles: prev.subtitles.map(s =>
                s.storyboard_id === storyboardId ? { ...s, regenerating: false } : s
              ),
            }
          })
          removeSubTask(scriptId, storyboardId)
          delete subPollTimersRef.current[storyboardId]
          setRegeneratingSubtitleStoryboardIds(prev => {
            const next = new Set(prev)
            next.delete(storyboardId)
            return next
          })
          toast({
            description: '字幕生成失败',
            variant: 'destructive',
          })
        } else {
          subPollTimersRef.current[storyboardId] = setTimeout(
            () => pollSubtitleStatus(storyboardId, clipId, taskUuid),
            3000
          )
        }
      } catch (err) {
        console.error('Failed to poll subtitle status:', err)
        subPollTimersRef.current[storyboardId] = setTimeout(
          () => pollSubtitleStatus(storyboardId, clipId, taskUuid),
          5000
        )
      }
    },
    [scriptId, clipDurationMap]
  )

  // Handle subtitle regeneration
  const handleSubtitleRegenerate = useCallback(
    async (storyboardId: number) => {
      const clip = draft.clips.find(c => c.storyboard_id === storyboardId)
      if (!clip) return

      if (subPollTimersRef.current[storyboardId]) {
        clearTimeout(subPollTimersRef.current[storyboardId])
        delete subPollTimersRef.current[storyboardId]
      }

      saveToHistory()
      // Mark subtitles as regenerating
      setRegeneratingSubtitleStoryboardIds(prev => {
        const next = new Set(prev)
        next.add(storyboardId)
        return next
      })
      setDraft(prev => ({
        ...prev,
        subtitles: prev.subtitles.map(s =>
          s.storyboard_id === storyboardId ? { ...s, regenerating: true } : s
        ),
      }))

      try {
        const res = await compositionApis.regenerateSubtitles({
          clip_id: clip.clip_id,
          script_id: scriptId,
          trim_start: clip.trim_start,
          trim_end: clip.trim_end,
          save_to_db: false,
        })
        saveSubTask(scriptId, storyboardId, clip.clip_id, res.task_uuid)
        subPollTimersRef.current[storyboardId] = setTimeout(
          () => pollSubtitleStatus(storyboardId, clip.clip_id, res.task_uuid),
          3000
        )
      } catch (err) {
        console.error('Failed to regenerate subtitles:', err)
        // Revert regenerating flag
        setRegeneratingSubtitleStoryboardIds(prev => {
          const next = new Set(prev)
          next.delete(storyboardId)
          return next
        })
        setDraft(prev => ({
          ...prev,
          subtitles: prev.subtitles.map(s =>
            s.storyboard_id === storyboardId ? { ...s, regenerating: false } : s
          ),
        }))
      }
    },
    [draft.clips, scriptId, pollSubtitleStatus, saveToHistory]
  )

  // Cleanup subtitle poll timers on unmount
  useEffect(() => {
    return () => {
      Object.values(subPollTimersRef.current).forEach(clearTimeout)
    }
  }, [])

  // Resume subtitle polling for tasks cached in localStorage
  useEffect(() => {
    const cachedTasks = loadSubTasks(scriptId)
    if (cachedTasks.length === 0) return

    setRegeneratingSubtitleStoryboardIds(new Set(cachedTasks.map(t => t.storyboard_id)))
    setDraft(prev => ({
      ...prev,
      subtitles: prev.subtitles.map(s => {
        const cached = cachedTasks.find(t => t.storyboard_id === s.storyboard_id)
        if (!cached) return s
        return { ...s, regenerating: true }
      }),
    }))

    const timer = setTimeout(() => {
      for (const task of cachedTasks) {
        pollSubtitleStatus(task.storyboard_id, task.clip_id, task.task_uuid)
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [scriptId, pollSubtitleStatus])

  // Handle audio track click (switch to BGM tab)
  const handleBgmClick = useCallback(() => {
    setSelectedClipIndex(null)
    setInspectorTab('bgm')
  }, [])

  const handleTimelineSeek = useCallback((time: number) => {
    setPreviewSeekTime(time)
    setCurrentGlobalTime(time)
  }, [])

  const handleSelectClip = useCallback(
    (index: number | null) => {
      if (index != null) {
        setSelectedClipIndex(index)
        setSubtitleClipIndex(index)
        setInspectorTab('clip')
        const globalStart = getClipGlobalStartTime(index, clips, clipDurationMap)
        setCurrentGlobalTime(globalStart)
        setPreviewSeekTime(null)
        requestAnimationFrame(() => setPreviewSeekTime(globalStart))
      } else {
        setSelectedClipIndex(null)
      }
    },
    [clips, clipDurationMap]
  )

  const handleSubtitleClipChange = useCallback((index: number) => {
    setSubtitleClipIndex(index)
  }, [])

  // Persist version selection changes to the backend (called before saveComposition)
  const persistVersionChanges = useCallback(async () => {
    const overrides = draft.localVersionOverride ?? {}
    const changedStoryboardIds = Object.keys(overrides)
      .map(Number)
      .filter(sbId => overrides[sbId] !== selectedVersionMap[sbId])

    if (changedStoryboardIds.length === 0) return

    await Promise.all(
      changedStoryboardIds.map(sbId =>
        storyboardApis.updateStoryboardVideoSelection(scriptId, sbId, overrides[sbId])
      )
    )
  }, [draft.localVersionOverride, selectedVersionMap, scriptId])

  // Save and generate final video
  const handleSaveAndGenerate = useCallback(async () => {
    if (!onRenderFinalVideo) return

    // Save unsaved changes first
    if (hasUnsavedChanges) {
      const initial = initialDraftRef.current

      const initialSubByStoryboard = new Map<number, CompositionSubtitle[]>()
      for (const sub of initial.subtitles) {
        const list = initialSubByStoryboard.get(sub.storyboard_id ?? -1) ?? []
        list.push(sub)
        initialSubByStoryboard.set(sub.storyboard_id ?? -1, list)
      }

      const currentSubByStoryboard = new Map<number, CompositionSubtitle[]>()
      for (const sub of draft.subtitles) {
        const list = currentSubByStoryboard.get(sub.storyboard_id ?? -1) ?? []
        list.push(sub)
        currentSubByStoryboard.set(sub.storyboard_id ?? -1, list)
      }

      function areSubtitlesEqual(a: CompositionSubtitle[], b: CompositionSubtitle[]): boolean {
        if (a.length !== b.length) return false
        const sortedA = [...a].sort((x, y) => x.id.localeCompare(y.id))
        const sortedB = [...b].sort((x, y) => x.id.localeCompare(y.id))
        return sortedA.every((sub, i) => {
          const other = sortedB[i]
          return (
            sub.start === other.start &&
            sub.end === other.end &&
            sub.text === other.text &&
            sub.enabled === other.enabled
          )
        })
      }

      const changedClips = draft.clips.filter(clip => {
        const initClip = initial.clips.find(c => c.storyboard_id === clip.storyboard_id)
        if (!initClip) return true
        const clipChanged =
          clip.clip_id !== initClip.clip_id ||
          clip.trim_start !== initClip.trim_start ||
          clip.trim_end !== initClip.trim_end ||
          clip.enabled !== initClip.enabled ||
          clip.volume !== initClip.volume
        const subsChanged = !areSubtitlesEqual(
          currentSubByStoryboard.get(clip.storyboard_id) ?? [],
          initialSubByStoryboard.get(clip.storyboard_id) ?? []
        )
        return clipChanged || subsChanged
      })

      const payload = {
        script_id: draft.script_id,
        task_id: draft.task_id,
        clips: changedClips.map(clip => ({
          storyboard_id: clip.storyboard_id,
          clip_id: clip.clip_id,
          trim_start: clip.trim_start,
          trim_end: clip.trim_end,
          enabled: clip.enabled,
          volume: clip.volume,
          srt_text: buildSrt(
            draft.subtitles.filter(sub => sub.storyboard_id === clip.storyboard_id)
          ),
        })),
        bgm: draft.bgm.map(b => ({
          idx: b.idx,
          start_time: b.start_time,
          end_time: b.end_time,
          audio_url: b.audio_url,
          media_id: b.media_id,
          volume: b.volume,
          prompt: b.prompt,
          mood: b.mood,
          style: b.style,
        })),
        subtitles_enabled: subtitlesVisible,
        bgm_enabled: draft.bgmEnabled,
      }

      try {
        setIsSaving(true)
        await persistVersionChanges()
        const res = await compositionApis.saveComposition(draft.id, payload)
        initialDraftRef.current = { ...draft, localVersionOverride: undefined }
        initialSubtitlesVisibleRef.current = subtitlesVisible
        setHistoryPast([])
        setHistoryFuture([])
        setSaveVersion(v => v + 1)
        onSaveSuccess?.(res)
      } catch (err) {
        console.error('Failed to save composition:', err)
        setIsSaving(false)
        return
      } finally {
        setIsSaving(false)
      }
    }

    await onRenderFinalVideo(draft.id)
  }, [
    draft,
    hasUnsavedChanges,
    onRenderFinalVideo,
    onSaveSuccess,
    subtitlesVisible,
    persistVersionChanges,
  ])

  // Save composition changes (only send modified clips)
  const handleSaveChanges = useCallback(async () => {
    const initial = initialDraftRef.current

    const initialSubByStoryboard = new Map<number, CompositionSubtitle[]>()
    for (const sub of initial.subtitles) {
      const list = initialSubByStoryboard.get(sub.storyboard_id ?? -1) ?? []
      list.push(sub)
      initialSubByStoryboard.set(sub.storyboard_id ?? -1, list)
    }

    const currentSubByStoryboard = new Map<number, CompositionSubtitle[]>()
    for (const sub of draft.subtitles) {
      const list = currentSubByStoryboard.get(sub.storyboard_id ?? -1) ?? []
      list.push(sub)
      currentSubByStoryboard.set(sub.storyboard_id ?? -1, list)
    }

    function areSubtitlesEqual(a: CompositionSubtitle[], b: CompositionSubtitle[]): boolean {
      if (a.length !== b.length) return false
      const sortedA = [...a].sort((x, y) => x.id.localeCompare(y.id))
      const sortedB = [...b].sort((x, y) => x.id.localeCompare(y.id))
      return sortedA.every((sub, i) => {
        const other = sortedB[i]
        return (
          sub.start === other.start &&
          sub.end === other.end &&
          sub.text === other.text &&
          sub.enabled === other.enabled
        )
      })
    }

    const changedClips = draft.clips.filter(clip => {
      const initClip = initial.clips.find(c => c.storyboard_id === clip.storyboard_id)
      if (!initClip) return true
      const clipChanged =
        clip.clip_id !== initClip.clip_id ||
        clip.trim_start !== initClip.trim_start ||
        clip.trim_end !== initClip.trim_end ||
        clip.enabled !== initClip.enabled ||
        clip.volume !== initClip.volume
      const subsChanged = !areSubtitlesEqual(
        currentSubByStoryboard.get(clip.storyboard_id) ?? [],
        initialSubByStoryboard.get(clip.storyboard_id) ?? []
      )
      return clipChanged || subsChanged
    })

    const payload = {
      script_id: draft.script_id,
      task_id: draft.task_id,
      clips: changedClips.map(clip => ({
        storyboard_id: clip.storyboard_id,
        clip_id: clip.clip_id,
        trim_start: clip.trim_start,
        trim_end: clip.trim_end,
        enabled: clip.enabled,
        volume: clip.volume,
        srt_text: buildSrt(draft.subtitles.filter(sub => sub.storyboard_id === clip.storyboard_id)),
      })),
      bgm: draft.bgm.map(b => ({
        idx: b.idx,
        start_time: b.start_time,
        end_time: b.end_time,
        audio_url: b.audio_url,
        media_id: b.media_id,
        volume: b.volume,
        prompt: b.prompt,
        mood: b.mood,
        style: b.style,
      })),
      subtitles_enabled: subtitlesVisible,
      bgm_enabled: draft.bgmEnabled,
    }

    try {
      setIsSaving(true)
      await persistVersionChanges()
      const res = await compositionApis.saveComposition(draft.id, payload)
      // Update initial refs to match saved state — trust local state post-save
      initialDraftRef.current = { ...draft, localVersionOverride: undefined }
      initialSubtitlesVisibleRef.current = subtitlesVisible
      setHistoryPast([])
      setHistoryFuture([])
      setSaveVersion(v => v + 1)
      onSaveSuccess?.(res)
    } catch (err) {
      console.error('Failed to save composition:', err)
    } finally {
      setIsSaving(false)
    }
  }, [draft, subtitlesVisible, onSaveSuccess, persistVersionChanges])

  const handleSetFinalCover = useCallback(
    async (selection: {
      clip_id: number
      cover_time_in_source: number
      local_preview_url?: string
    }) => {
      try {
        setIsUploadingCover(true)
        if (selection.local_preview_url) {
          setLocalFinalVideoCoverPreviewUrl(selection.local_preview_url)
        }
        const res = await compositionApis.updateFinalVideoCover(scriptId, {
          clip_id: selection.clip_id,
          cover_time_in_source: selection.cover_time_in_source,
        })
        const nextCover: FinalVideoCover = {
          clip_id: res.clip_id,
          cover_time_in_source: res.cover_time_in_source,
          cover_url: res.cover_url,
          generation_status: res.generation_status,
          generation_task_uuid: res.generation_task_uuid,
          generation_error: res.generation_error,
          source: 'manual',
          updated_at: res.updated_at,
        }
        setSavedFinalVideoCover(nextCover)
        onFinalVideoCoverChange?.(nextCover)
        setIsCoverPickerOpen(false)
        toast({ description: res.message })
      } catch (err) {
        const description = err instanceof Error ? err.message : '设置最终视频封面失败'
        toast({ description, variant: 'destructive' })
      } finally {
        setIsUploadingCover(false)
      }
    },
    [onFinalVideoCoverChange, scriptId]
  )

  const handleDeleteCover = useCallback(async () => {
    try {
      await compositionApis.removeFinalVideoCover(scriptId)
      setSavedFinalVideoCover(null)
      setLocalFinalVideoCoverPreviewUrl(null)
      onFinalVideoCoverChange?.(null)
      toast({ description: '封面已删除' })
    } catch (err) {
      const description = err instanceof Error ? err.message : '删除封面失败'
      toast({ description, variant: 'destructive' })
    }
  }, [onFinalVideoCoverChange, scriptId])

  return (
    <div
      data-testid="video-composition-editor"
      className="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden p-1 bg-[linear-gradient(180deg,rgb(var(--color-bg-base))_0%,rgb(var(--color-bg-surface))_100%)] text-text-primary"
      style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
    >
      {/* Top action bar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/80 bg-[#FFFFFF] px-5 h-12 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary h-8 min-w-[44px]"
            onClick={handleRequestClose}
            data-testid="video-composition-back"
          >
            <ArrowLeft className="w-4 h-4" />
            返回分镜
          </button>
        </div>

        <div className="flex items-center gap-3">
          {!readOnly && (
            <button
              className="px-3 py-1.5 rounded-[8px] text-[14px] leading-5 transition-colors h-8 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                fontFamily: "'PingFang SC', sans-serif",
                backgroundColor: !hasUnsavedChanges || isSaving ? '#f5f5f5' : '#ffffff',
                color: !hasUnsavedChanges || isSaving ? '#c0c0c0' : '#333333',
                cursor: !hasUnsavedChanges || isSaving ? 'default' : 'pointer',
                border:
                  !hasUnsavedChanges || isSaving ? '1px solid transparent' : '1px solid #e0e0e0',
              }}
              onClick={handleSaveChanges}
              data-testid="video-composition-save"
              disabled={!hasUnsavedChanges || isSaving}
            >
              保存变更
            </button>
          )}
          {!readOnly && onRenderFinalVideo && (
            <button
              className="px-3 py-0 rounded-lg text-sm bg-primary text-white hover:bg-primary/90 transition-colors h-8 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ fontFamily: "'PingFang SC', sans-serif" }}
              onClick={handleSaveAndGenerate}
              data-testid="video-composition-generate-final"
              disabled={isSaving}
            >
              生成视频
            </button>
          )}
        </div>
      </div>

      {/* Main content area */}
      <div className="flex min-h-0 min-w-0 flex-1 mt-1 gap-1 overflow-hidden">
        {/* Left: Preview */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border/80 bg-[#FFFFFF] shadow-[0_18px_60px_rgba(15,23,42,0.04)]">
            <div className="min-h-0 flex-1 px-4 pt-4 pb-0">
              <CompositionPreview
                clips={clips}
                clipVideoUrlMap={clipVideoUrlMap}
                clipCoverUrlMap={clipCoverUrlMap}
                clipDurationMap={clipDurationMap}
                subtitles={subtitles}
                subtitlesVisible={subtitlesVisible}
                bgm={draft.bgm}
                bgmEnabled={draft.bgmEnabled}
                isPlaying={isPlaying}
                seekTime={previewSeekTime}
                onPlayStateChange={setIsPlaying}
                onCurrentClipIndexChange={setSelectedClipIndex}
                onGlobalTimeChange={setCurrentGlobalTime}
                onSubtitlesVisibleChange={setSubtitlesVisible}
                onBgmEnabledChange={handleBgmEnabledChange}
                onSubtitleClick={() => {
                  setInspectorTab('subtitle')
                  if (selectedClipIndex != null) setSubtitleClipIndex(selectedClipIndex)
                }}
                onBgmClick={handleBgmClick}
                ratio={ratio}
              />
            </div>
          </div>
        </div>

        {/* Right: Inspector */}
        <div style={{ width: 426 }} className="flex-shrink-0">
          <div className="h-full overflow-hidden border border-border/80 bg-[#FFFFFF] shadow-[0_18px_60px_rgba(15,23,42,0.03)]">
            <ClipInspector
              clip={inspectorClip}
              clipIndex={inspectorClipIndex}
              clips={clips}
              clipOriginalDuration={inspectorClipOriginalDuration}
              storyboardInfo={storyboardInfoMap}
              subtitles={subtitles}
              bgm={draft.bgm}
              bgmEnabled={draft.bgmEnabled}
              subtitlesVisible={subtitlesVisible}
              subtitleClipIndex={subtitleClipIndex}
              onSubtitleClipChange={handleSubtitleClipChange}
              activeTab={inspectorTab}
              onActiveTabChange={setInspectorTab}
              onTrimChange={handleTrimChange}
              onClipVolumeChange={handleClipVolumeChange}
              onClipEnabledChange={handleClipEnabledChange}
              onSubtitleChange={handleSubtitleChange}
              onSubtitleAdd={handleSubtitleAdd}
              onSubtitleDelete={handleSubtitleDelete}
              onSubtitlesVisibilityChange={setSubtitlesVisible}
              onSubtitleRegenerate={handleSubtitleRegenerate}
              regeneratingSubtitleStoryboardIds={regeneratingSubtitleStoryboardIds}
              selectedSubtitleId={timelineSelectedSubtitleId}
              onSubtitleFocus={setTimelineSelectedSubtitleId}
              onSelectClip={handleSelectClip}
              onBgmEnabledChange={handleBgmEnabledChange}
              onBgmVolumeChange={handleBgmVolumeChange}
              onBgmPromptChange={handleBgmPromptChange}
              onBgmDelete={handleBgmDelete}
              onBgmAdd={handleBgmAdd}
              onBgmTimeChange={handleBgmTimeChange}
              onBgmRegenerate={handleBgmRegenerate}
              selectedBgmIdx={selectedBgmIdx}
              onBgmFocus={setSelectedBgmIdx}
              readOnly={readOnly}
            />
          </div>
        </div>
      </div>

      {/* Bottom: Timeline */}
      <div
        style={{
          height: 293,
          borderBottomWidth: '1px',
          borderBottomStyle: 'solid',
          borderBottomColor: 'rgba(228, 228, 228, 0.8)',
        }}
        className="flex-shrink-0 overflow-hidden border border-border/80 bg-[#FFFFFF] shadow-[0_-18px_60px_rgba(15,23,42,0.04)] mt-1"
      >
        <ClipTimeline
          clips={clips}
          clipCoverUrlMap={clipCoverUrlMap}
          clipVideoUrlMap={clipVideoUrlMap}
          clipDurationMap={clipDurationMap}
          finalVideoCoverPreviewUrl={
            localFinalVideoCoverPreviewUrl ??
            savedFinalVideoCover?.cover_url ??
            (savedFinalVideoCover ? (clipCoverUrlMap[savedFinalVideoCover.clip_id] ?? null) : null)
          }
          subtitles={subtitles}
          selectedClipIndex={selectedClipIndex}
          bgm={draft.bgm}
          bgmEnabled={draft.bgmEnabled}
          currentTime={currentGlobalTime}
          onSelectClip={handleSelectClip}
          onTrimClip={handleTimelineTrimChange}
          onOpenCoverPicker={
            readOnly
              ? undefined
              : () => {
                  setIsCoverPickerOpen(true)
                }
          }
          onDeleteCover={readOnly ? undefined : handleDeleteCover}
          onMusicClick={handleBgmClick}
          onSubtitleClick={(storyboardId?: number) => {
            setInspectorTab('subtitle')
            if (storyboardId != null) {
              const idx = clips.findIndex(c => c.storyboard_id === storyboardId)
              if (idx !== -1) setSubtitleClipIndex(idx)
            } else if (selectedClipIndex != null) {
              setSubtitleClipIndex(selectedClipIndex)
            }
          }}
          onSubtitleSelect={setTimelineSelectedSubtitleId}
          selectedSubtitleId={timelineSelectedSubtitleId}
          subtitlesVisible={subtitlesVisible}
          onSeekTimeline={handleTimelineSeek}
          onBgmTimeChange={handleBgmTimeChange}
          selectedBgmIdx={selectedBgmIdx}
          onBgmSelect={setSelectedBgmIdx}
          onSubtitleTimeChange={handleSubtitleTimeChange}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={historyPast.length > 0}
          canRedo={historyFuture.length > 0}
          readOnly={readOnly}
        />
      </div>

      <FinalCoverPickerDialog
        open={isCoverPickerOpen}
        onOpenChange={setIsCoverPickerOpen}
        clips={draft.clips}
        clipCoverUrlMap={clipCoverUrlMap}
        clipVideoUrlMap={clipVideoUrlMap}
        clipDurationMap={clipDurationMap}
        finalVideoCover={savedFinalVideoCover}
        localPreviewUrl={localFinalVideoCoverPreviewUrl}
        isSubmitting={isUploadingCover}
        ratio={ratio}
        onConfirm={handleSetFinalCover}
      />

      {/* Unsaved changes confirmation dialog */}
      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>未保存的更改</AlertDialogTitle>
            <AlertDialogDescription>
              你有未保存的更改，关闭后将丢失所有修改。确定要放弃更改吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={handleCancelDiscard}
              className="border-primary/60 text-primary hover:bg-primary/10 hover:text-primary"
            >
              继续编辑
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDiscard}
              className="bg-primary text-white hover:bg-primary/90"
            >
              放弃更改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
