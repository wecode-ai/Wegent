// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
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
  const [copyError, setCopyError] = useState<string | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Check if we're in a secure context where clipboard API works
  const isSecureContext = useCallback(() => {
    return (
      window.isSecureContext ||
      window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
    )
  }, [])

  // Helper function to copy text to clipboard
  const copyToClipboard = useCallback(
    async (text: string): Promise<{ success: boolean; needsManualCopy: boolean }> => {
      // In secure context, use Clipboard API
      if (isSecureContext() && navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text)
          return { success: true, needsManualCopy: false }
        } catch (err) {
          console.warn('Clipboard API failed:', err)
        }
      }

      // In non-secure context (HTTP), we cannot reliably copy to clipboard
      // The execCommand('copy') may return true but not actually copy
      // So we return needsManualCopy: true to indicate user should copy manually
      return { success: false, needsManualCopy: true }
    },
    [isSecureContext]
  )

  // Fetch or create share link when dialog opens
  useEffect(() => {
    if (open && kbId) {
      const fetchShareLink = async () => {
        setIsLoading(true)
        setError(null)
        setCopyError(null)
        setCopied(false) // Reset copied state when dialog opens
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

  const handleCopy = useCallback(async () => {
    setCopyError(null)
    if (!shareLink) {
      setCopyError(t('document.permission.noLinkToCopy') || 'No link to copy')
      return
    }

    const result = await copyToClipboard(shareLink)
    if (result.success) {
      setCopied(true)
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } else if (result.needsManualCopy) {
      // In non-secure context, select the input so user can manually copy with Ctrl+C
      setCopyError(
        t('document.permission.copyFailedManual') || 'Please press Ctrl+C to copy the selected link'
      )
      if (inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    }
  }, [shareLink, copyToClipboard, t])

  // Select all text when clicking on the input
  const handleInputClick = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.select()
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby="share-link-description">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="w-5 h-5" />
            {t('document.permission.shareLink')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p id="share-link-description" className="text-sm text-text-secondary">
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
                <input
                  ref={inputRef}
                  type="text"
                  value={shareLink}
                  readOnly
                  onClick={handleInputClick}
                  className="flex-1 p-3 bg-muted rounded-lg text-sm font-mono border-0 outline-none focus:ring-2 focus:ring-primary"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  className="flex-shrink-0"
                  title={t('document.permission.copyLink')}
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
              {copyError && <p className="text-sm text-warning">{copyError}</p>}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
