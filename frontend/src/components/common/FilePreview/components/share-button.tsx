// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect } from 'react'
import { Share2, Check, Loader2, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { createAttachmentShareLink, type PublicShareLinkResponse } from '@/apis/attachments'

interface ExpiryOption {
  days: number
  labelKey: string
}

interface ShareButtonProps {
  /** Attachment ID to share */
  attachmentId: number
  /** Whether the user can share (owner only) */
  canShare?: boolean
  /** Button variant */
  variant?: 'default' | 'outline' | 'ghost'
  /** Button size */
  size?: 'sm' | 'default' | 'icon'
  /** Additional CSS classes */
  className?: string
}

// Helper: Create share link with error handling
async function createShareLink(
  attachmentId: number,
  days: number
): Promise<PublicShareLinkResponse> {
  return createAttachmentShareLink(attachmentId, days)
}

// Helper: Copy to clipboard with fallback
async function copyToClipboard(shareUrl: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(shareUrl)
    return true
  } catch {
    return false
  }
}

export function ShareButton({
  attachmentId,
  canShare,
  variant = 'outline',
  size = 'sm',
  className = '',
}: ShareButtonProps) {
  const { t, i18n } = useTranslation('common')
  const { toast } = useToast()
  const [isSharing, setIsSharing] = useState(false)
  const [shared, setShared] = useState(false)
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef<number | null>(null)

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Expiry options - supporting up to 3650 days (10 years) for long-term access
  const expiryOptions: ExpiryOption[] = [
    { days: 1, labelKey: 'attachment.share.expiry.1day' },
    { days: 7, labelKey: 'attachment.share.expiry.7days' },
    { days: 30, labelKey: 'attachment.share.expiry.30days' },
    { days: 365, labelKey: 'attachment.share.expiry.1year' },
    { days: 3650, labelKey: 'attachment.share.expiry.10years' },
  ]

  const handleShare = async (days: number) => {
    if (!attachmentId || !canShare) return

    setIsSharing(true)
    setOpen(false)

    // Step 1: Create share link
    let response: PublicShareLinkResponse
    try {
      response = await createShareLink(attachmentId, days)
    } catch (err) {
      console.error('Failed to create share link:', err)
      setIsSharing(false)
      toast({
        variant: 'destructive',
        title: t('attachment.share.generate_failed_title'),
        description: err instanceof Error ? err.message : t('attachment.share.retry'),
      })
      return
    }

    // Step 2: Copy to clipboard
    const copied = await copyToClipboard(response.share_url)
    if (!copied) {
      setIsSharing(false)
      toast({
        variant: 'destructive',
        title: t('attachment.share.copy_failed_title'),
        description: response.share_url,
      })
      return
    }

    setShared(true)

    // Step 3: Show success toast with server-provided expiry
    const expiryDate = new Date(response.expires_at)
    const formattedDate = expiryDate.toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })

    toast({
      title: t('attachment.share.link_copied_title'),
      description: t('attachment.share.link_copied_with_expiry', {
        date: formattedDate,
      }),
    })

    // Step 4: Set expiry timer
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = window.setTimeout(() => setShared(false), 2000)

    setIsSharing(false)
  }

  if (!canShare) {
    return null
  }

  const buttonIcon = isSharing ? (
    <Loader2 className="w-4 h-4 animate-spin" />
  ) : shared ? (
    <Check className="w-4 h-4" />
  ) : (
    <Share2 className="w-4 h-4" />
  )

  const buttonText = isSharing
    ? t('actions.generating')
    : shared
      ? t('actions.copied')
      : t('actions.share')

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={size}
          disabled={isSharing}
          className={`h-9 px-2 sm:px-3 ${className}`}
          title={t('actions.share')}
        >
          {buttonIcon}
          <span className="hidden sm:inline ml-2">{buttonText}</span>
          {!isSharing && !shared && <ChevronDown className="w-3 h-3 ml-1 opacity-50" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t('attachment.share.expiry.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {expiryOptions.map(option => (
          <DropdownMenuItem
            key={option.days}
            onClick={() => handleShare(option.days)}
            disabled={isSharing}
          >
            {t(option.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
