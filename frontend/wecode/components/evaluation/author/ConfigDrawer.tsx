// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Eye, EyeOff, Loader2, Upload, Trash2, FileVideo, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
// Tabs component imported but using custom tab implementation for drawer
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ExamInstructionsMarkdown } from '@wecode/components/evaluation/exam/ExamInstructionsMarkdown'
import { SubmitHintMarkdown } from '@wecode/components/evaluation/exam/SubmitHintMarkdown'
import { getAuthorTopic, updateAuthorTopic } from '@wecode/api/evaluation-author'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import { TopicVisibility, type Topic } from '@wecode/types/evaluation'
import type { ExamVideoAttachment } from '@wecode/types/evaluation-exam'
import { uploadEvaluationFile } from '@wecode/api/evaluation-shared'
import { cn, sanitizeFilename } from '@/lib/utils'
import { ExamVideoPlayer } from '@wecode/components/evaluation/exam/ExamVideoPlayer'

/**
 * Props for the ConfigDrawer component
 */
interface ConfigDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean
  /** Topic ID to edit */
  topicId: number
  /** Callback when drawer is closed */
  onClose: () => void
  /** Callback when topic is updated */
  onTopicUpdate?: (topic: Topic) => void
}

/**
 * ConfigDrawer - Slide-out drawer for topic configuration
 *
 * Features:
 * - Slides in from the right side
 * - Unified configuration form (no tabs)
 * - Form validation
 * - Loading states
 * - Markdown preview for instructions
 * - Video upload with preview/download
 */
export function ConfigDrawer({ isOpen, topicId, onClose, onTopicUpdate }: ConfigDrawerProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Basic form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<string>(TopicVisibility.PRIVATE)
  const [instructions, setInstructions] = useState('')
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false)

  // Exam config state (three-phase: intro, exam, review)
  const [introMinutes, setIntroMinutes] = useState(5)
  const [examMinutes, setExamMinutes] = useState(50)
  const [reviewMinutes, setReviewMinutes] = useState(5)

  // Submit hint config state
  const [submitHint, setSubmitHint] = useState('')
  const [showSubmitHintPreview, setShowSubmitHintPreview] = useState(false)

  // Video upload state
  const [videoAttachment, setVideoAttachment] = useState<ExamVideoAttachment | null>(null)
  const [videoUploadProgress, setVideoUploadProgress] = useState(0)
  const [isUploadingVideo, setIsUploadingVideo] = useState(false)
  const [isDraggingVideo, setIsDraggingVideo] = useState(false)
  const [isDownloadingVideo, setIsDownloadingVideo] = useState(false)
  const [showVideoPlayer, setShowVideoPlayer] = useState(false)
  const videoInputRef = useRef<HTMLInputElement>(null)

  // Track if initial data has been loaded to prevent re-fetching
  const [initialLoaded, setInitialLoaded] = useState(false)

  // Load topic data when drawer opens
  const loadData = useCallback(async () => {
    if (!topicId) return

    setLoading(true)
    try {
      const topicData = await getAuthorTopic(topicId)

      // Load basic info
      setName(topicData.name)
      setDescription(topicData.description || '')
      setVisibility(topicData.visibility)
      // instructions is stored in extra_data by backend
      setInstructions((topicData.extra_data?.instructions as string) || '')

      // Load exam duration config from extra_data
      const extraData = topicData.extra_data as Record<string, unknown> | undefined
      const duration = extraData?.duration as
        | { intro?: number; exam?: number; review?: number }
        | undefined
      if (duration) {
        setIntroMinutes(duration.intro ?? 5)
        setExamMinutes(duration.exam ?? 50)
        setReviewMinutes(duration.review ?? 5)
      }

      // Load video attachment from extra_data
      setVideoAttachment((extraData?.video as ExamVideoAttachment) || null)

      // Load submit hint from extra_data
      setSubmitHint((extraData?.submit_hint as string) || '')

      setInitialLoaded(true)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      onClose()
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, onClose])

  // Load data only once when drawer opens
  useEffect(() => {
    if (isOpen && !initialLoaded) {
      loadData()
    }
  }, [isOpen, initialLoaded, loadData])

  // Reset form when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setShowInstructionsPreview(false)
      setVideoAttachment(null)
      setVideoUploadProgress(0)
      setIsUploadingVideo(false)
      setShowVideoPlayer(false)
      setInitialLoaded(false) // Reset so next open will reload data
    }
  }, [isOpen])

  const handleSave = async () => {
    if (!name.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('topics.name') + ' is required',
        variant: 'destructive',
      })
      return
    }

    setSaving(true)
    try {
      const updatedTopic = await updateAuthorTopic(topicId, {
        name: name.trim(),
        visibility,
        extra_data: {
          description: description.trim() || undefined,
          instructions: instructions.trim() || undefined,
          duration: {
            intro: introMinutes,
            exam: examMinutes,
            review: reviewMinutes,
          },
          video: videoAttachment || undefined,
          submit_hint: submitHint.trim() || undefined,
        },
      })

      toast({
        title: t('topics.updated_success', 'Topic updated successfully'),
        description: '',
      })

      onTopicUpdate?.(updatedTopic)
      onClose()
    } catch (error) {
      toast({
        title: t('errors.save_failed'),
        description: error instanceof Error ? error.message : t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    onClose()
  }

  // Video upload handlers
  const handleVideoSelect = async (files: FileList | null) => {
    if (!files || files.length === 0 || saving) return

    const file = files[0]

    // Validate file type
    if (!file.type.startsWith('video/')) {
      toast({
        title: t('errors.save_failed', 'Upload Failed'),
        description: t('topics.video_invalid_type', 'Please select a valid video file'),
        variant: 'destructive',
      })
      return
    }

    setIsUploadingVideo(true)
    setVideoUploadProgress(0)

    try {
      const sanitizedName = sanitizeFilename(file.name)
      const fileToUpload =
        sanitizedName !== file.name ? new File([file], sanitizedName, { type: file.type }) : file

      const response = await uploadEvaluationFile(
        fileToUpload,
        'topic_attachment',
        topicId,
        undefined,
        'video',
        (progress: number) => {
          setVideoUploadProgress(progress)
        }
      )

      const newAttachment: ExamVideoAttachment = {
        key: response.key,
        filename: sanitizedName,
        size: fileToUpload.size,
        content_type: fileToUpload.type,
      }

      setVideoAttachment(newAttachment)
      toast({
        title: t('topics.video_uploaded', 'Video uploaded successfully'),
        description: '',
      })
    } catch (error) {
      toast({
        title: t('errors.save_failed', 'Upload Failed'),
        description: error instanceof Error ? error.message : t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsUploadingVideo(false)
      setVideoUploadProgress(0)
    }
  }

  const handleVideoRemove = () => {
    setVideoAttachment(null)
    setShowVideoPlayer(false)
  }

  const handleVideoDownload = async () => {
    if (!videoAttachment) return

    setIsDownloadingVideo(true)
    try {
      await downloadEvaluationFile(videoAttachment.key, videoAttachment.filename)
      toast({
        title: t('topics.video_download_started', 'Download started'),
        description: '',
      })
    } catch (error) {
      toast({
        title: t('errors.download_failed', 'Download failed'),
        description: error instanceof Error ? error.message : t('errors.download_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsDownloadingVideo(false)
    }
  }

  const handleVideoPlay = () => {
    setShowVideoPlayer(true)
  }

  const handleVideoDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingVideo(false)
    handleVideoSelect(e.dataTransfer.files)
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1048576).toFixed(1)} MB`
  }

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 transition-opacity"
        onClick={handleCancel}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-4xl transform transition-transform duration-300 ease-in-out bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">
              {t('topics.config_title', 'Topic Configuration')}
            </h2>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="h-8 w-8 p-0"
            aria-label={t('common:actions.close')}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Content - scrollable area */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-10 bg-gray-100 rounded" />
              <div className="h-32 bg-gray-100 rounded" />
              <div className="h-10 bg-gray-100 rounded" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Topic Name */}
              <div className="space-y-2">
                <Label htmlFor="name">
                  {t('topics.name', 'Topic Name')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('topics.name', 'Topic Name')}
                  maxLength={200}
                  disabled={saving}
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">{t('topics.description', 'Description')}</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t('topics.description', 'Description')}
                  rows={3}
                  maxLength={2000}
                  disabled={saving}
                />
              </div>

              {/* Visibility */}
              <div className="space-y-2">
                <Label htmlFor="visibility">{t('topics.visibility', 'Visibility')}</Label>
                <Select value={visibility} onValueChange={setVisibility} disabled={saving}>
                  <SelectTrigger id="visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">{t('topics.private', 'Private')}</SelectItem>
                    <SelectItem value="public">{t('topics.public', 'Public')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  {visibility === 'public'
                    ? t(
                        'topics.public_description',
                        'Anyone can view and answer questions in this topic'
                      )
                    : t(
                        'topics.private_description',
                        'Only invited users can view and answer questions'
                      )}
                </p>
              </div>

              {/* Divider - Exam Configuration */}
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-sm font-medium text-gray-900 mb-4">
                  {t('topics.exam_config', 'Exam Configuration')}
                </h3>

                {/* Duration - Three Phase */}
                <div className="grid gap-4 md:grid-cols-3 mb-6">
                  <div className="space-y-2">
                    <Label htmlFor="introMinutes">
                      {t('evaluation:exam.intro_duration', 'Intro (min)')}
                    </Label>
                    <Input
                      id="introMinutes"
                      type="number"
                      value={introMinutes}
                      onChange={e => setIntroMinutes(parseInt(e.target.value) || 0)}
                      min={0}
                      disabled={saving}
                    />
                    <p className="text-xs text-gray-500">
                      {t('evaluation:exam.intro_hint', 'Pre-exam introduction')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="examMinutes">
                      {t('evaluation:exam.exam_duration', 'Exam (min)')}
                    </Label>
                    <Input
                      id="examMinutes"
                      type="number"
                      value={examMinutes}
                      onChange={e => setExamMinutes(parseInt(e.target.value) || 0)}
                      min={1}
                      disabled={saving}
                    />
                    <p className="text-xs text-gray-500">
                      {t('evaluation:exam.exam_hint', 'Main exam time')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reviewMinutes">
                      {t('evaluation:exam.review_duration', 'Review (min)')}
                    </Label>
                    <Input
                      id="reviewMinutes"
                      type="number"
                      value={reviewMinutes}
                      onChange={e => setReviewMinutes(parseInt(e.target.value) || 0)}
                      min={0}
                      disabled={saving}
                    />
                    <p className="text-xs text-gray-500">
                      {t('evaluation:exam.review_hint', 'Final review')}
                    </p>
                  </div>
                </div>

                {/* Video Upload */}
                <div className="space-y-2">
                  <Label>{t('topics.video_upload', 'Introduction Video (Optional)')}</Label>

                  {videoAttachment ? (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
                      {/* Video Player - using ExamVideoPlayer component */}
                      {showVideoPlayer && (
                        <div className="relative">
                          <ExamVideoPlayer
                            videoKey={videoAttachment.key}
                            filename={videoAttachment.filename}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowVideoPlayer(false)}
                            className="absolute top-2 right-2 h-8 w-8 p-0 bg-black/50 hover:bg-black/70 text-white z-20"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      )}

                      {/* File Info */}
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
                          <FileVideo className="h-5 w-5 text-red-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {videoAttachment.filename}
                          </p>
                          <p className="text-xs text-gray-500">
                            {formatFileSize(videoAttachment.size)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {!showVideoPlayer && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleVideoPlay}
                              disabled={saving}
                              className="h-8 px-3 text-xs"
                            >
                              {t('topics.video_play', 'Play')}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handleVideoDownload}
                            disabled={saving || isDownloadingVideo}
                            className="h-8 w-8 p-0 text-gray-500 hover:text-green-600"
                            title={t('topics.video_download', 'Download')}
                          >
                            {isDownloadingVideo ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handleVideoRemove}
                            disabled={saving}
                            className="h-8 w-8 p-0 text-gray-500 hover:text-red-600"
                            title={t('common:actions.delete', 'Delete')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : isUploadingVideo ? (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <div className="flex items-center gap-3 mb-2">
                        <Loader2 className="h-5 w-5 animate-spin text-red-600" />
                        <span className="text-sm text-gray-700">
                          {t('topics.video_uploading', 'Uploading video...')}
                        </span>
                      </div>
                      <Progress value={videoUploadProgress} className="h-2" />
                      <p className="text-xs text-gray-500 mt-1">{videoUploadProgress}%</p>
                    </div>
                  ) : (
                    <div
                      onClick={() => videoInputRef.current?.click()}
                      onDragOver={e => {
                        e.preventDefault()
                        setIsDraggingVideo(true)
                      }}
                      onDragLeave={() => setIsDraggingVideo(false)}
                      onDrop={handleVideoDrop}
                      className={cn(
                        'rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors',
                        isDraggingVideo
                          ? 'border-red-500 bg-red-50'
                          : 'border-gray-300 hover:border-gray-400 bg-white'
                      )}
                    >
                      <div className="flex flex-col items-center gap-2 text-center">
                        <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                          <Upload className="h-5 w-5 text-gray-500" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-700">
                            {t('topics.video_drop_or_click', 'Click or drag video here')}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            {t('topics.video_hint', 'MP4, MOV, AVI up to 500MB')}
                          </p>
                        </div>
                      </div>
                      <input
                        ref={videoInputRef}
                        type="file"
                        accept="video/*"
                        onChange={e => handleVideoSelect(e.target.files)}
                        className="hidden"
                        disabled={saving}
                      />
                    </div>
                  )}
                </div>

                {/* Instructions (after video) */}
                <div className="space-y-2 mt-6">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="instructions">{t('topics.instructions')}</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowInstructionsPreview(!showInstructionsPreview)}
                      disabled={saving}
                    >
                      {showInstructionsPreview ? (
                        <>
                          <EyeOff className="mr-1 h-4 w-4" />
                          {t('common:actions.edit')}
                        </>
                      ) : (
                        <>
                          <Eye className="mr-1 h-4 w-4" />
                          {t('questions.preview', 'Preview')}
                        </>
                      )}
                    </Button>
                  </div>
                  {showInstructionsPreview ? (
                    <div className="min-h-[120px] rounded-lg border border-gray-200 bg-white p-4">
                      {instructions.trim() ? (
                        <ExamInstructionsMarkdown content={instructions} />
                      ) : (
                        <p className="text-gray-400">{t('topics.no_instructions')}</p>
                      )}
                    </div>
                  ) : (
                    <Textarea
                      id="instructions"
                      value={instructions}
                      onChange={e => setInstructions(e.target.value)}
                      placeholder={t('topics.instructions_placeholder')}
                      rows={6}
                      className="font-mono text-sm"
                      disabled={saving}
                    />
                  )}
                  <p className="text-xs text-gray-500">{t('topics.instructions_hint')}</p>
                </div>

                {/* Submit Hint */}
                <div className="space-y-2 mt-6">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="submitHint">{t('topics.submit_hint', '交卷提示')}</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSubmitHintPreview(!showSubmitHintPreview)}
                      disabled={saving}
                    >
                      {showSubmitHintPreview ? (
                        <>
                          <EyeOff className="mr-1 h-4 w-4" />
                          {t('common:actions.edit')}
                        </>
                      ) : (
                        <>
                          <Eye className="mr-1 h-4 w-4" />
                          {t('questions.preview', 'Preview')}
                        </>
                      )}
                    </Button>
                  </div>
                  {showSubmitHintPreview ? (
                    <div className="min-h-[80px] rounded-lg border border-gray-200 bg-gray-50 p-4">
                      {submitHint.trim() ? (
                        <SubmitHintMarkdown content={submitHint} className="text-sm" />
                      ) : null}
                    </div>
                  ) : (
                    <Textarea
                      id="submitHint"
                      value={submitHint}
                      onChange={e => setSubmitHint(e.target.value)}
                      placeholder={t(
                        'topics.submit_hint_placeholder',
                        '请输入交卷提示，支持 Markdown 格式'
                      )}
                      rows={4}
                      className="font-mono text-sm"
                      disabled={saving}
                    />
                  )}
                  <p className="text-xs text-gray-500">
                    {t(
                      'topics.submit_hint_hint',
                      '支持 Markdown 格式，将在交卷预览、确认交卷、考试已结束等位置展示'
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-gray-100 bg-white">
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={handleCancel} disabled={saving}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleSave}
              disabled={saving || loading}
              className="bg-[#DF2029] hover:bg-[#c81d25]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:actions.saving', 'Saving...')}
                </>
              ) : (
                t('common:actions.save', 'Save')
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
