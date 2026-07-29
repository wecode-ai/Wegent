// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeBase } from '@/types/knowledge'
import { DocumentList, type KbGroupInfo } from './DocumentList'
import { WorkspaceSidePanel } from './WorkspaceSidePanel'

interface KnowledgeSourcePanelProps {
  knowledgeBase: KnowledgeBase
  selectedDocumentIds: number[]
  availableDocumentCount: number | null
  canUploadDocuments: boolean
  canManageAllDocuments: boolean
  mobileVisible: boolean
  refreshToken: number
  groupInfo?: KbGroupInfo
  onGroupClick?: (groupId: string, groupType?: string) => void
  initialDocPath?: string
  initialDocumentId?: number
  isOrganization?: boolean
  onDocumentSelectionChange: (documentIds: number[]) => void
  onRefreshKnowledgeBase?: () => void
  onSourcesChanged: () => void
}

export function KnowledgeSourcePanel({
  knowledgeBase,
  selectedDocumentIds,
  availableDocumentCount,
  canUploadDocuments,
  canManageAllDocuments,
  mobileVisible,
  refreshToken,
  groupInfo,
  onGroupClick,
  initialDocPath,
  initialDocumentId,
  isOrganization = false,
  onDocumentSelectionChange,
  onRefreshKnowledgeBase,
  onSourcesChanged,
}: KnowledgeSourcePanelProps) {
  const { t } = useTranslation('knowledge')

  return (
    <WorkspaceSidePanel
      side="left"
      storageKey="kb-source-panel-v2"
      defaultWidth={420}
      minWidth={280}
      maxWidth={600}
      mobileVisible={mobileVisible}
      expandLabel={t('artifact.showSources')}
      collapseLabel={t('artifact.hideSources')}
      resizeLabel={t('artifact.resizeSources')}
      expandTestId="knowledge-source-panel-expand-button"
      collapseTestId="knowledge-source-panel-collapse-button"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="knowledge-source-panel">
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-3">
          <DocumentList
            knowledgeBase={knowledgeBase}
            canUpload={canUploadDocuments}
            canManageAllDocuments={canManageAllDocuments}
            compact
            paginationEnabled
            sourceWorkspace
            selectedDocumentIds={selectedDocumentIds}
            availableDocumentCount={availableDocumentCount}
            refreshToken={refreshToken}
            groupInfo={groupInfo}
            onGroupClick={onGroupClick}
            initialDocPath={initialDocPath}
            initialDocumentId={initialDocumentId}
            isOrganization={isOrganization}
            onSelectionChange={onDocumentSelectionChange}
            onRefreshKnowledgeBase={onRefreshKnowledgeBase}
            onDocumentsChanged={onSourcesChanged}
          />
        </div>
      </div>
    </WorkspaceSidePanel>
  )
}
