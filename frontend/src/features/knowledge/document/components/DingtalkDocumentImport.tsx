// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, Check, FileText, Loader2 } from 'lucide-react'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'
import { cn } from '@/lib/utils'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'

// Flatten a synced DingTalk node tree into the importable doc nodes.
function flattenImportableDocNodes(nodes: DingtalkDocNode[]): DingtalkDocNode[] {
  const result: DingtalkDocNode[] = []
  const walk = (items: DingtalkDocNode[]) => {
    for (const item of items) {
      if (item.node_type === 'doc') result.push(item)
      if (item.children?.length) walk(item.children)
    }
  }
  walk(nodes)
  return result
}

interface DingtalkDocumentImportProps {
  /** Return to the upload source picker */
  onBack: () => void
  /** Import one DingTalk document; resolves on success, rejects on failure */
  onImport: (node: DingtalkDocNode) => Promise<void>
  /** Currently selected folder ID for import destination (0 = root) */
  folderId?: number
  /** Flat list of folder names with IDs for the selector */
  folderOptions?: Array<{ id: number; name: string; depth: number }>
  /** Callback when folder selection changes */
  onFolderChange?: (folderId: number) => void
}

export function DingtalkDocumentImport({
  onBack,
  onImport,
  folderId = 0,
  folderOptions = [],
  onFolderChange,
}: DingtalkDocumentImportProps) {
  const { t } = useTranslation('knowledge')
  const [docs, setDocs] = useState<DingtalkDocNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [notConfigured, setNotConfigured] = useState(false)

  // Load importable DingTalk docs on mount; this component only lives while
  // the dingtalk mode is active, so unmounting resets all import state.
  const loadDocs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await dingtalkDocApi.getSyncStatus()
      if (!status.is_configured) {
        setNotConfigured(true)
        setDocs([])
        return
      }
      setNotConfigured(false)
      const tree = await dingtalkDocApi.getDocs()
      setDocs(flattenImportableDocNodes(tree.nodes))
    } catch {
      setError(t('document.upload.dingtalk.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadDocs()
  }, [loadDocs])

  const handleSubmit = useCallback(async () => {
    if (!selectedId) return
    const node = docs.find(doc => doc.dingtalk_node_id === selectedId)
    if (!node) return

    setSubmitting(true)
    setError(null)
    try {
      await onImport(node)
    } catch (err) {
      setError(mapKnowledgeDocumentErrorMessage(err, t, 'document.upload.dingtalk.addFailed'))
    } finally {
      setSubmitting(false)
    }
  }, [selectedId, docs, onImport, t])

  return (
    <>
      <DialogHeader className="flex flex-row items-center gap-2 space-y-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onBack}
          disabled={submitting}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <DialogTitle>{t('document.upload.dingtalk.title')}</DialogTitle>
      </DialogHeader>

      <div className="py-4 space-y-4">
        <p className="text-sm text-text-secondary">{t('document.upload.dingtalk.hint')}</p>

        {loading && (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-text-secondary">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('document.upload.dingtalk.loading')}
          </div>
        )}

        {!loading && notConfigured && (
          <div className="flex items-center gap-2 p-3 bg-surface rounded-lg text-sm text-text-secondary">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{t('document.upload.dingtalk.notConfigured')}</span>
          </div>
        )}

        {!loading && !notConfigured && docs.length === 0 && !error && (
          <div className="p-3 bg-surface rounded-lg text-sm text-text-secondary">
            {t('document.upload.dingtalk.empty')}
          </div>
        )}

        {!loading && docs.length > 0 && (
          <div
            className="border border-border rounded-lg divide-y divide-border max-h-[260px] overflow-y-auto"
            data-testid="dingtalk-document-list"
          >
            {docs.map(node => {
              const selected = selectedId === node.dingtalk_node_id
              return (
                <button
                  key={node.dingtalk_node_id}
                  type="button"
                  className={cn(
                    'w-full flex items-center gap-3 p-3 text-left transition-colors',
                    selected ? 'bg-primary/5' : 'hover:bg-surface'
                  )}
                  onClick={() => setSelectedId(node.dingtalk_node_id)}
                  disabled={submitting}
                  data-testid={`dingtalk-document-option-${node.dingtalk_node_id}`}
                >
                  <FileText className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="flex-1 truncate text-sm text-text-primary">{node.name}</span>
                  {selected && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                </button>
              )
            })}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {folderOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">{t('document.folder.selectFolder')}</Label>
            <Select value={String(folderId)} onValueChange={val => onFolderChange?.(Number(val))}>
              <SelectTrigger className="h-11 min-w-[44px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t('document.folder.rootLevel')}</SelectItem>
                {folderOptions.map(folder => (
                  <SelectItem key={folder.id} value={String(folder.id)}>
                    {'\u00A0'.repeat(folder.depth * 2)}
                    {folder.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!selectedId || submitting}
          data-testid="dingtalk-import-submit"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('document.upload.adding')}
            </>
          ) : (
            t('document.upload.dingtalk.submitButton')
          )}
        </Button>
      </div>
    </>
  )
}
