// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  registerExternalSourceOpener,
  type ExternalSourceOpener,
} from '@/features/tasks/components/chat/SourceReferences'
import { getExternalKnowledgePreview } from '@wecode/api/external-knowledge'
import type { SourceReference } from '@/types/socket'
import type { ExternalKnowledgePreview } from '@wecode/types/external-knowledge'
import { ExternalKnowledgePreviewDialog } from './components/ExternalKnowledgePreviewDialog'

interface ApSourceIdentity {
  kbId: string
  documentId: string
}

function parseApSourceUri(sourceUri?: string): ApSourceIdentity | null {
  if (!sourceUri) return null

  const prefix = 'ap://'
  if (!sourceUri.startsWith(prefix)) return null

  const value = sourceUri.slice(prefix.length)
  const separatorIndex = value.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null
  }

  try {
    return {
      kbId: decodeURIComponent(value.slice(0, separatorIndex)),
      documentId: decodeURIComponent(value.slice(separatorIndex + 1)),
    }
  } catch {
    return null
  }
}

function ApSourceOpenButton({ source }: { source: SourceReference }) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<ExternalKnowledgePreview | null>(null)
  const title = source.title || source.source_name || source.source_id || t('external.opener.title')
  const identity = parseApSourceUri(source.source_uri)

  const handleOpen = async () => {
    if (!identity) {
      toast({ title: t('external.opener.invalidSource'), variant: 'destructive' })
      return
    }

    setLoading(true)
    try {
      const resolvedPreview = await getExternalKnowledgePreview('ap', {
        kb_id: identity.kbId,
        document_id: identity.documentId,
      })
      if (resolvedPreview.preview_mode === 'new_tab') {
        window.open(resolvedPreview.url, '_blank', 'noopener,noreferrer')
        return
      }
      setPreview(resolvedPreview)
    } catch {
      toast({ title: t('external.preview.failed'), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 max-w-md gap-1 px-1.5 text-xs text-text-secondary hover:text-primary"
        onClick={handleOpen}
        disabled={loading || !identity}
        title={identity ? source.source_uri : t('external.opener.invalidSource')}
        data-testid={`ap-source-open-button-${source.index}`}
      >
        <span className="truncate">{title}</span>
        <Badge variant="info" size="sm" className="border-primary/30 bg-primary/10 text-primary">
          {t('external.ap.readonlyBadge')}
        </Badge>
        {loading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ExternalLink className="h-3 w-3 shrink-0" />
        )}
      </Button>

      <ExternalKnowledgePreviewDialog
        open={Boolean(preview)}
        onOpenChange={open => {
          if (!open) setPreview(null)
        }}
        preview={preview}
        title={title}
        testId="ap-source-preview"
        iframeTestId="ap-source-preview-iframe"
      />
    </>
  )
}

const apSourceOpener: ExternalSourceOpener = source => <ApSourceOpenButton source={source} />

registerExternalSourceOpener('ap', apSourceOpener)
