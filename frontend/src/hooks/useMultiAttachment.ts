// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing multiple file attachments state and upload.
 */

import {
  createElement,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  uploadFile,
  deleteAttachment,
  validateFile as validateAttachmentFile,
  getErrorMessageFromCode,
  getFileExtension,
  isAudioExtension,
  isImageExtension,
  isVideoExtension,
} from '@/apis/attachments'
import { ApiError } from '@/apis/client'
import type { WeiboAccountPreviewResponse } from '@/apis/user'
import { userApis } from '@/apis/user'
import { useUser } from '@/features/common/UserContext'
import type { MultiAttachmentUploadState, TruncationInfo } from '@/types/api'
import { toast } from '@/hooks/use-toast'
import { WeiboVideoBindingPrompt } from './WeiboVideoBindingPrompt'

interface UseMultiAttachmentReturn {
  /** Current attachment state */
  state: MultiAttachmentUploadState
  /** Handle file selection and upload */
  handleFileSelect: (files: File | File[]) => Promise<void>
  /** Add an already-uploaded attachment directly (e.g., reference image from history) */
  addExistingAttachment: (attachment: import('@/types/api').Attachment) => void
  /** Remove specific attachment */
  handleRemove: (attachmentId: number) => Promise<void>
  /** Swap two attachments without re-uploading them */
  swapAttachments: (firstAttachmentId: number, secondAttachmentId: number) => void
  /** Reset state */
  reset: () => void
  /** Check if ready to send (no upload in progress, all attachments ready) */
  isReadyToSend: boolean
  /** Check if any upload is in progress */
  isUploading: boolean
  /** Truncation info for attachments that were truncated */
  truncatedAttachments: Map<number, TruncationInfo>
  /** Dialog prompting unbound users to bind Weibo before video upload */
  weiboBindingPrompt: ReactNode
}

export type AttachmentTypeLimits = Partial<
  Record<'image' | 'imageWithVideo' | 'video' | 'audio', number>
>

export function useMultiAttachment(options?: {
  maxAttachments?: number
  showTruncationToast?: boolean
  maxByType?: AttachmentTypeLimits
  validateFile?: (file: File) => Promise<string | null>
  storagePurpose?: 'default' | 'video_reference'
}): UseMultiAttachmentReturn {
  const { t } = useTranslation()
  const { user, refresh } = useUser()
  const maxAttachments = options?.maxAttachments
  const showTruncationToast = options?.showTruncationToast ?? false
  const maxByType = options?.maxByType
  const customValidateFile = options?.validateFile
  const storagePurpose = options?.storagePurpose ?? 'default'
  const [state, setState] = useState<MultiAttachmentUploadState>({
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  })
  const [truncatedAttachments, setTruncatedAttachments] = useState<Map<number, TruncationInfo>>(
    new Map()
  )
  const localPreviewUrlsRef = useRef(new Set<string>())
  const [pendingVideoFiles, setPendingVideoFiles] = useState<File[] | null>(null)
  const [previewAccount, setPreviewAccount] = useState<WeiboAccountPreviewResponse | null>(null)
  const [isPreviewingWeibo, setIsPreviewingWeibo] = useState(false)
  const [isBindingWeibo, setIsBindingWeibo] = useState(false)

  const createLocalPreviewUrl = useCallback((file: File, mediaType: string | null) => {
    if (
      !['video', 'audio'].includes(mediaType ?? '') ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return undefined
    }
    const url = URL.createObjectURL(file)
    localPreviewUrlsRef.current.add(url)
    return url
  }, [])

  const revokeLocalPreviewUrl = useCallback((url?: string) => {
    if (!url || !localPreviewUrlsRef.current.delete(url)) return
    URL.revokeObjectURL(url)
  }, [])

  useEffect(() => {
    const previewUrls = localPreviewUrlsRef.current
    return () => {
      previewUrls.forEach(url => URL.revokeObjectURL(url))
      previewUrls.clear()
    }
  }, [])

  const uploadSelectedFiles = useCallback(
    async (fileList: File[]) => {
      // Clear previous errors before new upload attempt
      setState(prev => ({
        ...prev,
        errors: new Map(),
      }))

      // Check attachment count limit (applies to image/video generation modes)
      if (maxAttachments !== undefined) {
        const currentCount = state.attachments.length + state.uploadingFiles.size
        const incomingCount = fileList.length
        if (currentCount + incomingCount > maxAttachments) {
          toast({
            title: t('chat:generate.attachment_limit_reached'),
            description: t('chat:generate.max_attachments', { count: maxAttachments }),
            variant: 'default',
          })
          return
        }
      }

      const getMediaType = (filename: string) => {
        const extension = getFileExtension(filename)
        if (isImageExtension(extension)) return 'image' as const
        if (isVideoExtension(extension)) return 'video' as const
        if (isAudioExtension(extension)) return 'audio' as const
        return null
      }
      const counts = { image: 0, video: 0, audio: 0 }
      for (const attachment of state.attachments) {
        const type = getMediaType(attachment.filename)
        if (type) counts[type] += 1
      }
      for (const uploading of state.uploadingFiles.values()) {
        const type = getMediaType(uploading.file.name)
        if (type) counts[type] += 1
      }

      for (const file of fileList) {
        // Use only filename as fileId to avoid duplicate errors for the same file
        const fileId = file.name
        const mediaType = getMediaType(file.name)

        if (
          mediaType === 'video' &&
          maxByType?.imageWithVideo !== undefined &&
          counts.image > maxByType.imageWithVideo
        ) {
          toast({
            title: t('chat:generate.max_material_type', {
              count: maxByType.imageWithVideo,
            }),
            variant: 'destructive',
          })
          continue
        }

        const maximum =
          mediaType === 'image' && counts.video > 0
            ? (maxByType?.imageWithVideo ?? maxByType?.image)
            : mediaType
              ? maxByType?.[mediaType]
              : undefined
        if (mediaType && maximum !== undefined) {
          if (counts[mediaType] >= maximum) {
            toast({
              title: t('chat:generate.max_material_type', { count: maximum }),
              variant: 'destructive',
            })
            continue
          }
        }

        if (customValidateFile) {
          const validationError = await customValidateFile(file)
          if (validationError) {
            toast({
              title: validationError,
              variant: 'destructive',
            })
            continue
          }
        }

        // Validate file
        const validationError = validateAttachmentFile(file, t)
        if (validationError) {
          setState(prev => {
            const newErrors = new Map(prev.errors)
            newErrors.set(fileId, validationError)
            return { ...prev, errors: newErrors }
          })
          continue
        }

        // Start upload
        setState(prev => {
          const newUploadingFiles = new Map(prev.uploadingFiles)
          newUploadingFiles.set(fileId, { file, progress: 0 })
          const newErrors = new Map(prev.errors)
          newErrors.delete(fileId)
          return {
            ...prev,
            uploadingFiles: newUploadingFiles,
            errors: newErrors,
          }
        })

        try {
          const attachment = await uploadFile(
            file,
            progress => {
              setState(prev => {
                const newUploadingFiles = new Map(prev.uploadingFiles)
                const existing = newUploadingFiles.get(fileId)
                if (existing) {
                  newUploadingFiles.set(fileId, { ...existing, progress })
                }
                return { ...prev, uploadingFiles: newUploadingFiles }
              })
            },
            undefined,
            storagePurpose
          )

          // Check if parsing succeeded
          if (attachment.status === 'failed') {
            const errorMessage =
              getErrorMessageFromCode(attachment.error_code, t) ||
              attachment.error_message ||
              t('common:attachment.errors.parse_failed')
            setState(prev => {
              const newUploadingFiles = new Map(prev.uploadingFiles)
              newUploadingFiles.delete(fileId)
              const newErrors = new Map(prev.errors)
              newErrors.set(fileId, errorMessage)
              return {
                ...prev,
                uploadingFiles: newUploadingFiles,
                errors: newErrors,
              }
            })
            // Try to delete the failed attachment
            try {
              await deleteAttachment(attachment.id)
            } catch {
              // Ignore delete errors
            }
            continue
          }

          // Store truncation info if present
          if (attachment.truncation_info?.is_truncated) {
            setTruncatedAttachments(prev => {
              const newMap = new Map(prev)
              newMap.set(attachment.id, attachment.truncation_info!)
              return newMap
            })
            if (showTruncationToast) {
              toast({
                title: t('common:attachment.errors.content_truncated'),
                description: t('common:attachment.truncation.notice', {
                  original: attachment.truncation_info.original_length?.toLocaleString(),
                  truncated: attachment.truncation_info.truncated_length?.toLocaleString(),
                }),
                variant: 'default',
              })
            }
          }

          const localPreviewUrl = createLocalPreviewUrl(file, mediaType)

          // Add to attachments list
          setState(prev => {
            const newUploadingFiles = new Map(prev.uploadingFiles)
            newUploadingFiles.delete(fileId)
            return {
              ...prev,
              attachments: [
                ...prev.attachments,
                {
                  id: attachment.id,
                  filename: attachment.filename,
                  file_size: attachment.file_size,
                  mime_type: attachment.mime_type,
                  status: attachment.status,
                  text_length: attachment.text_length,
                  error_message: attachment.error_message,
                  error_code: attachment.error_code,
                  subtask_id: null,
                  file_extension: file.name.substring(file.name.lastIndexOf('.')),
                  created_at: new Date().toISOString(),
                  truncation_info: attachment.truncation_info,
                  external_media_type: attachment.external_media_type,
                  text_count: attachment.text_count,
                  video_count: attachment.video_count,
                  image_count: attachment.image_count,
                  comment_count: attachment.comment_count,
                  fetched_comment_count: attachment.fetched_comment_count,
                  site: attachment.site,
                  source_url: attachment.source_url,
                  cover_url: attachment.cover_url,
                  local_preview_url: localPreviewUrl,
                },
              ],
              uploadingFiles: newUploadingFiles,
            }
          })
          if (mediaType) counts[mediaType] += 1
        } catch (err) {
          setState(prev => {
            const newUploadingFiles = new Map(prev.uploadingFiles)
            newUploadingFiles.delete(fileId)
            const newErrors = new Map(prev.errors)
            newErrors.set(
              fileId,
              `${t('common:attachment.errors.network_error')}: ${(err as Error).message || t('common:attachment.errors.network_error_hint')}`
            )
            return {
              ...prev,
              uploadingFiles: newUploadingFiles,
              errors: newErrors,
            }
          })
        }
      }
    },
    [
      state,
      t,
      maxAttachments,
      maxByType,
      customValidateFile,
      showTruncationToast,
      createLocalPreviewUrl,
      storagePurpose,
    ]
  )

  const handleFileSelect = useCallback(
    async (files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files]
      const hasChatVideo =
        storagePurpose === 'default' &&
        fileList.some(file => isVideoExtension(getFileExtension(file.name)))

      if (hasChatVideo && !user?.weibo_uid) {
        setPreviewAccount(null)
        setPendingVideoFiles(fileList)
        return
      }

      await uploadSelectedFiles(fileList)
    },
    [storagePurpose, uploadSelectedFiles, user?.weibo_uid]
  )

  const closeWeiboPrompt = useCallback(() => {
    if (isPreviewingWeibo || isBindingWeibo) return
    setPendingVideoFiles(null)
    setPreviewAccount(null)
  }, [isPreviewingWeibo, isBindingWeibo])

  const continuePendingVideoUpload = useCallback(async () => {
    const files = pendingVideoFiles
    if (!files) return
    setPendingVideoFiles(null)
    setPreviewAccount(null)
    await uploadSelectedFiles(files)
  }, [pendingVideoFiles, uploadSelectedFiles])

  const showWeiboBindErrorToast = useCallback(
    (error: unknown) => {
      const errorCode = error instanceof ApiError ? error.errorCode : undefined
      const title =
        errorCode === 'weibo_sub_missing'
          ? t('settings:weiboBinding.subMissing')
          : errorCode === 'weibo_uid_changed'
            ? t('settings:weiboBinding.accountChanged')
            : t('settings:weiboBinding.bindFailed')
      toast({ variant: 'destructive', title })
    },
    [t]
  )

  const previewWeiboAccount = useCallback(async () => {
    setIsPreviewingWeibo(true)
    try {
      const preview = await userApis.previewWeiboAccount()
      setPreviewAccount(preview)
    } catch (error) {
      showWeiboBindErrorToast(error)
    } finally {
      setIsPreviewingWeibo(false)
    }
  }, [showWeiboBindErrorToast])

  const confirmWeiboBindAndUpload = useCallback(async () => {
    if (!previewAccount) return
    setIsBindingWeibo(true)
    try {
      await userApis.bindWeiboAccount(previewAccount.weibo_uid)
      await refresh()
      await continuePendingVideoUpload()
      toast({ title: t('chat:weiboVideoBinding.bindSuccess') })
    } catch (error) {
      if (error instanceof ApiError && error.errorCode === 'weibo_uid_changed') {
        setPreviewAccount(null)
      }
      showWeiboBindErrorToast(error)
    } finally {
      setIsBindingWeibo(false)
    }
  }, [continuePendingVideoUpload, previewAccount, refresh, showWeiboBindErrorToast, t])

  const weiboBindingPrompt = useMemo(
    () =>
      createElement(WeiboVideoBindingPrompt, {
        open: Boolean(pendingVideoFiles),
        previewAccount,
        isPreviewing: isPreviewingWeibo,
        isBinding: isBindingWeibo,
        onOpenChange: (open: boolean) => {
          if (!open) closeWeiboPrompt()
        },
        onContinueWithoutBinding: continuePendingVideoUpload,
        onPreview: previewWeiboAccount,
        onConfirmBind: confirmWeiboBindAndUpload,
      }),
    [
      closeWeiboPrompt,
      confirmWeiboBindAndUpload,
      continuePendingVideoUpload,
      isBindingWeibo,
      isPreviewingWeibo,
      pendingVideoFiles,
      previewAccount,
      previewWeiboAccount,
    ]
  )

  const addExistingAttachment = useCallback(
    (attachment: import('@/types/api').Attachment) => {
      setState(prev => {
        // Skip if already in the list (deduplication by id)
        if (prev.attachments.some(a => a.id === attachment.id)) {
          return prev
        }
        // Respect the maxAttachments cap so re-edit flows cannot exceed the limit
        // Include uploading files in the count to prevent exceeding the limit
        const currentTotal = prev.attachments.length + prev.uploadingFiles.size
        if (maxAttachments !== undefined && currentTotal >= maxAttachments) {
          return prev
        }
        return {
          ...prev,
          attachments: [...prev.attachments, attachment],
        }
      })
    },
    [maxAttachments]
  )

  const handleRemove = useCallback(
    async (attachmentId: number) => {
      const attachment = state.attachments.find(a => a.id === attachmentId)
      revokeLocalPreviewUrl(attachment?.local_preview_url)

      // Remove from state immediately for better UX
      setState(prev => ({
        ...prev,
        attachments: prev.attachments.filter(a => a.id !== attachmentId),
      }))

      // Remove truncation info
      setTruncatedAttachments(prev => {
        const newMap = new Map(prev)
        newMap.delete(attachmentId)
        return newMap
      })

      // Try to delete from server if it exists and is not linked to a subtask
      if (attachment && !attachment.subtask_id) {
        try {
          await deleteAttachment(attachmentId)
        } catch {
          // Ignore delete errors - attachment might already be linked
        }
      }
    },
    [state.attachments, revokeLocalPreviewUrl]
  )

  const swapAttachments = useCallback((firstAttachmentId: number, secondAttachmentId: number) => {
    setState(prev => {
      const firstIndex = prev.attachments.findIndex(
        attachment => attachment.id === firstAttachmentId
      )
      const secondIndex = prev.attachments.findIndex(
        attachment => attachment.id === secondAttachmentId
      )
      if (firstIndex < 0 || secondIndex < 0) return prev

      const attachments = [...prev.attachments]
      ;[attachments[firstIndex], attachments[secondIndex]] = [
        attachments[secondIndex],
        attachments[firstIndex],
      ]
      return { ...prev, attachments }
    })
  }, [])

  const reset = useCallback(() => {
    state.attachments.forEach(attachment => {
      revokeLocalPreviewUrl(attachment.local_preview_url)
    })
    setState({
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    })
    setTruncatedAttachments(new Map())
    setPendingVideoFiles(null)
    setPreviewAccount(null)
  }, [state.attachments, revokeLocalPreviewUrl])

  const isUploading = state.uploadingFiles.size > 0
  const isReadyToSend = !isUploading && state.attachments.every(att => att.status === 'ready')

  return {
    state,
    handleFileSelect,
    addExistingAttachment,
    handleRemove,
    swapAttachments,
    reset,
    isReadyToSend,
    isUploading,
    truncatedAttachments,
    weiboBindingPrompt,
  }
}
