// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect } from 'react'
import { Link, Check, Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'

interface ShareLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  kbName: string
}

export function ShareLinkDialog({ open, onOpenChange, kbId, kbName }: ShareLinkDialogProps) {
  const { t } = useTranslation('knowledge')
  const [copied, setCopied] = useState(false)
  const [shareLink, setShareLink] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

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

  // Fetch or create share link when dialog opens
  useEffect(() => {
    if (open && kbId) {
      const fetchShareLink = async () => {
        setIsLoading(true)
        setError(null)
        try {
          // First try to get existing share link
          let link = await knowledgePermissionApi.getShareLink(kbId)

          // If no share link exists, create one
          if (!link) {
            link = await knowledgePermissionApi.createShareLink(kbId, {
              require_approval: true,
              default_permission_level: 'view',
            })
          }

          if (link) {
            setShareLink(link.share_url)
            // Auto-copy link
            const success = await copyToClipboard(link.share_url)
            if (success) {
              setCopied(true)
              if (timeoutRef.current) {
                clearTimeout(timeoutRef.current)
              }
              timeoutRef.current = setTimeout(() => setCopied(false), 2000)
            }
          }
        } catch (err) {
          console.error('Failed to get share link:', err)
          setError((err as Error)?.message || 'Failed to get share link')
        } finally {
          setIsLoading(false)
        }
      }
      fetchShareLink()
    }
  }, [open, kbId])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleCopy = async () => {
    if (!shareLink) return
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
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner className="w-6 h-6" />
            </div>
          ) : error ? (
            <div className="text-sm text-error text-center py-4">{error}</div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="flex-1 p-3 bg-muted rounded-lg text-sm break-all font-mono">
                  {shareLink}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  className="flex-shrink-0"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-success" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
              {copied && (
                <p className="text-sm text-success">{t('document.permission.linkCopied')}</p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
