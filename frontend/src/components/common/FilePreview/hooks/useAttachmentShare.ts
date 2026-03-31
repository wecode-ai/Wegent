// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from 'react'
import { createAttachmentShareLink } from '@/apis/attachments'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

export interface UseAttachmentShareOptions {
  /** Attachment ID to share */
  attachmentId?: number
  /** Whether the user can share (owner only) */
  canShare?: boolean
  /** Share link expiration in days (default: 7) */
  expiresInDays?: number
}

export interface UseAttachmentShareReturn {
  /** Whether a share operation is in progress */
  isSharing: boolean
  /** Whether the link was recently copied (auto-resets after 2s) */
  shared: boolean
  /** Function to trigger the share operation */
  share: () => Promise<void>
}

/**
 * Custom hook for attachment sharing functionality
 *
 * Handles creating share links, copying to clipboard, and showing toast notifications.
 * Automatically manages loading state and copied state with auto-reset.
 *
 * @example
 * ```tsx
 * const { isSharing, shared, share } = useAttachmentShare({
 *   attachmentId: 123,
 *   canShare: true,
 * })
 *
 * <Button onClick={share} disabled={isSharing}>
 *   {shared ? 'Copied!' : 'Share'}
 * </Button>
 * ```
 */
export function useAttachmentShare({
  attachmentId,
  canShare,
  expiresInDays = 7,
}: UseAttachmentShareOptions): UseAttachmentShareReturn {
  const { toast } = useToast()
  const { t } = useTranslation('common')
  const [isSharing, setIsSharing] = useState(false)
  const [shared, setShared] = useState(false)

  const share = useCallback(async () => {
    if (!attachmentId || !canShare) return

    setIsSharing(true)
    try {
      const response = await createAttachmentShareLink(attachmentId, expiresInDays)
      await navigator.clipboard.writeText(response.share_url)
      setShared(true)
      toast({
        title: t('attachment.share.link_copied_title'),
        description: t('attachment.share.link_copied_description'),
      })
      // Reset copied state after 2 seconds
      setTimeout(() => setShared(false), 2000)
    } catch (err) {
      console.error('Failed to create share link:', err)
      toast({
        variant: 'destructive',
        title: t('attachment.share.generate_failed_title'),
        description: err instanceof Error ? err.message : t('attachment.share.retry'),
      })
    } finally {
      setIsSharing(false)
    }
  }, [attachmentId, canShare, expiresInDays, toast, t])

  return {
    isSharing,
    shared,
    share,
  }
}
