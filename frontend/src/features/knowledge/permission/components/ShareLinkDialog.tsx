// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect } from 'react'
import { Link, Check, Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface ShareLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  kbName: string
}

export function ShareLinkDialog({ open, onOpenChange, kbId, kbName }: ShareLinkDialogProps) {
  const { t } = useTranslation('knowledge')
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Generate share link
  const shareLink =
    typeof window !== 'undefined' ? `${window.location.origin}/knowledge/share/${kbId}` : ''

  // Helper function to copy text to clipboard
  const copyToClipboard = async (text: string) => {
    try {
      // Use modern Clipboard API if available, fallback to execCommand
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for browsers/contexts where Clipboard API is not available
        const textArea = document.createElement('textarea')
        textArea.value = text
        textArea.style.position = 'fixed'
        textArea.style.left = '-9999px'
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand('copy')
        document.body.removeChild(textArea)
      }
      return true
    } catch (err) {
      console.error('Failed to copy:', err)
      return false
    }
  }

  // Auto-copy link when dialog opens
  useEffect(() => {
    if (open && shareLink) {
      copyToClipboard(shareLink).then(success => {
        if (success) {
          setCopied(true)
          // Clear any existing timeout
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
          }
          timeoutRef.current = setTimeout(() => setCopied(false), 2000)
        }
      })
    }
  }, [open, shareLink])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleCopy = async () => {
    const success = await copyToClipboard(shareLink)
    if (success) {
      setCopied(true)
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="w-5 h-5" />
            {t('document.permission.shareLink')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t('document.permission.shareLinkDescription', { name: kbName })}
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 p-3 bg-muted rounded-lg text-sm break-all font-mono">
              {shareLink}
            </div>
            <Button variant="outline" size="icon" onClick={handleCopy} className="flex-shrink-0">
              {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          {copied && <p className="text-sm text-success">{t('document.permission.linkCopied')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
