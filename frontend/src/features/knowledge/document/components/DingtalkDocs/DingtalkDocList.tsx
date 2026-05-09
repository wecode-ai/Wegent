// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingtalkDocList - Document list component for DingTalk documents.
 *
 * Displays a table of documents in the selected folder.
 */

'use client'

import { ExternalLink, FileText, Folder } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

/** Convert ISO date string to millisecond timestamp */
function isoToMs(dateStr: string): number | undefined {
  if (!dateStr) return undefined
  const ms = new Date(dateStr).getTime()
  return isNaN(ms) ? undefined : ms
}

interface DingtalkDocListProps {
  docs: DingtalkDocNode[]
  selectedFolderId: string | null
  onNavigateBack?: () => void
}

/** Get icon for a document based on node type */
function DocIcon({ nodeType }: { nodeType: string }) {
  if (nodeType === 'folder') {
    return <Folder className="w-4 h-4 text-text-secondary" />
  }
  return <FileText className="w-4 h-4 text-primary" />
}

export function DingtalkDocList({ docs, selectedFolderId, onNavigateBack }: DingtalkDocListProps) {
  const { t } = useTranslation('knowledge')

  return (
    <div className="p-4" data-testid="dingtalk-doc-list">
      {/* Back button when inside a folder - always rendered before empty check */}
      {selectedFolderId && onNavigateBack && (
        <button
          type="button"
          onClick={onNavigateBack}
          className="mb-3 h-11 min-w-[44px] text-sm text-primary hover:underline flex items-center gap-1"
          data-testid="dingtalk-back-button"
        >
          ← {t('document.dingtalk.backToParent', '返回上级')}
        </button>
      )}

      {docs.length === 0 && (
        <div className="flex items-center justify-center h-full text-text-muted text-sm p-8">
          {t('document.dingtalk.noDocsInFolder', '此文件夹下暂无文档')}
        </div>
      )}

      {/* Document table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-text-muted">
            <th className="text-left py-2 px-3 font-medium">
              {t('document.dingtalk.columnName', '名称')}
            </th>
            <th className="text-left py-2 px-3 font-medium w-40">
              {t('document.dingtalk.columnContentUpdatedAt', '文档更新时间')}
            </th>
            <th className="text-left py-2 px-3 font-medium w-40">
              {t('document.dingtalk.columnSyncedAt', '同步时间')}
            </th>
            <th className="text-right py-2 px-3 font-medium w-16">
              {t('document.dingtalk.columnActions', '操作')}
            </th>
          </tr>
        </thead>
        <tbody>
          {docs.map(doc => (
            <tr
              key={doc.dingtalk_node_id}
              className="border-b border-border/50 hover:bg-surface-hover transition-colors"
              data-testid={`dingtalk-doc-row-${doc.dingtalk_node_id}`}
            >
              <td className="py-2.5 px-3">
                <div className="flex items-center gap-2">
                  <DocIcon nodeType={doc.node_type} />
                  {doc.node_type === 'doc' || doc.node_type === 'file' ? (
                    <a
                      href={doc.doc_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text-primary hover:text-primary hover:underline truncate"
                    >
                      {doc.name}
                    </a>
                  ) : (
                    <span className="text-text-primary truncate">{doc.name}</span>
                  )}
                </div>
              </td>
              <td className="py-2.5 px-3 text-text-muted">
                {formatDateTime(isoToMs(doc.content_updated_at))}
              </td>
              <td className="py-2.5 px-3 text-text-muted">
                {formatDateTime(isoToMs(doc.last_synced_at))}
              </td>
              <td className="py-2.5 px-3 text-right">
                {(doc.node_type === 'doc' || doc.node_type === 'file') && (
                  <a
                    href={doc.doc_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center h-11 min-w-[44px] rounded-md hover:bg-surface-hover text-text-muted hover:text-primary transition-colors"
                    title={t('document.dingtalk.openInDingtalk', '在钉钉中打开')}
                    data-testid={`dingtalk-open-${doc.dingtalk_node_id}`}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
