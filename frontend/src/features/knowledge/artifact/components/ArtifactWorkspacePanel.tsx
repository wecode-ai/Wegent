// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ArtifactPromptRequest } from '@/types/knowledge-artifact'
import { WorkspaceSidePanel } from '@/features/knowledge/document/components/WorkspaceSidePanel'
import { ArtifactPanel } from './ArtifactPanel'

interface ArtifactWorkspacePanelProps {
  knowledgeBaseId: number
  selectedDocumentIds: number[]
  refreshToken: number
  mobileVisible: boolean
  onAdjustSources: (onApplied?: () => void) => void
  onAvailableDocumentCountChange: (count: number | null) => void
  onAskNode?: (request: ArtifactPromptRequest) => void
  onCreatePptDraft: () => void
}

export function ArtifactWorkspacePanel({
  knowledgeBaseId,
  selectedDocumentIds,
  refreshToken,
  mobileVisible,
  onAdjustSources,
  onAvailableDocumentCountChange,
  onAskNode,
  onCreatePptDraft,
}: ArtifactWorkspacePanelProps) {
  const { t } = useTranslation('knowledge')

  return (
    <WorkspaceSidePanel
      side="right"
      storageKey="kb-artifact-panel"
      defaultWidth={360}
      minWidth={280}
      maxWidth={520}
      collapsedWidth={72}
      mobileVisible={mobileVisible}
      expandLabel={t('artifact.showGeneration')}
      collapseLabel={t('artifact.hideGeneration')}
      resizeLabel={t('artifact.resizeGeneration')}
      expandTestId="knowledge-generation-panel-expand-button"
      collapseTestId="knowledge-generation-panel-collapse-button"
    >
      {({ isDesktopCollapsed }) => (
        <div
          className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
            isDesktopCollapsed ? 'px-2 pb-2 pt-14' : 'p-4'
          }`}
          data-testid="knowledge-generation-panel"
        >
          {!isDesktopCollapsed && (
            <h2 className="mb-4 pr-9 text-sm font-semibold">{t('artifact.generation')}</h2>
          )}
          <div className="min-h-0 flex-1">
            <ArtifactPanel
              knowledgeBaseId={knowledgeBaseId}
              selectedDocumentIds={selectedDocumentIds}
              refreshToken={refreshToken}
              layout={isDesktopCollapsed ? 'rail' : 'full'}
              onAdjustSources={onAdjustSources}
              onAvailableDocumentCountChange={onAvailableDocumentCountChange}
              onAskNode={onAskNode}
              onCreatePptDraft={onCreatePptDraft}
            />
          </div>
        </div>
      )}
    </WorkspaceSidePanel>
  )
}
