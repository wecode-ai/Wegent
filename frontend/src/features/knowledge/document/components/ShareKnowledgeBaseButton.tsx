// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Share knowledge base button component.
 * Allows users to copy share link for a knowledge base.
 */

'use client'

import { Share2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/useToast'

interface ShareKnowledgeBaseButtonProps {
  kbId: number
  variant?: 'default' | 'ghost' | 'outline'
  size?: 'default' | 'sm' | 'icon'
  showText?: boolean
  className?: string
}

export function ShareKnowledgeBaseButton({
  kbId,
  variant = 'ghost',
  size = 'icon',
  showText = false,
  className,
}: ShareKnowledgeBaseButtonProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const [isCopying, setIsCopying] = useState(false)

  const handleShare = async () => {
    setIsCopying(true)
    try {
      const shareUrl = `${window.location.origin}/knowledge/share/${kbId}`
      await navigator.clipboard.writeText(shareUrl)
      toast({
        description: t('share.link_copied'),
      })
    } catch (error) {
      console.error('Failed to copy link:', error)
      toast({
        variant: 'destructive',
        description: 'Failed to copy link',
      })
    } finally {
      setIsCopying(false)
    }
  }

  const button = (
    <Button
      variant={variant}
      size={size}
      onClick={handleShare}
      disabled={isCopying}
      className={className}
    >
      <Share2 className="h-4 w-4" />
      {showText && <span className="ml-2">{t('share.copy_link')}</span>}
    </Button>
  )

  if (showText) {
    return button
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{t('share.copy_link')}</TooltipContent>
    </Tooltip>
  )
}
