// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { FileText, Library, Shield } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUser } from '@/features/common/UserContext'
import { DocumentList } from '@/features/knowledge/document/components/DocumentList'
import { PermissionManagementTab } from '@/features/knowledge/permission/components/PermissionManagementTab'
import { useKnowledgePermissions } from '@/features/knowledge/permission/hooks/useKnowledgePermissions'
import { useNamespaceRoleMap } from '@/features/knowledge/document/hooks/useNamespaceRoleMap'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canManageKnowledgeBase,
  canManageKnowledgeBaseDocuments,
  canManageKnowledgeBasePermissions,
} from '@/utils/namespace-permissions'
import type {
  CodeWikiView,
  KbGroupInfo,
  KnowledgeBase,
  KnowledgeContentOrigin,
} from '@/types/knowledge'
import { CodeWikiReader } from './CodeWikiReader'

type DocumentManagementView = KnowledgeContentOrigin | 'permissions'

interface CodeWikiWorkspaceProps {
  wiki: KnowledgeBase
  view: CodeWikiView
  canConfigure?: boolean
  onConfigure?: () => void
  groupInfo?: KbGroupInfo
  onGroupClick?: (groupId: string, groupType?: string) => void
}

/**
 * The two product views of a Code Wiki share one knowledge-base identity.
 *
 * Wiki reads only the generation projection. Document Management surfaces the
 * same KB's two virtual content roots without encoding either root into paths.
 */
export function CodeWikiWorkspace({
  wiki,
  view,
  canConfigure = false,
  onConfigure,
  groupInfo,
  onGroupClick,
}: CodeWikiWorkspaceProps) {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()
  const namespaceRoleMap = useNamespaceRoleMap()
  const [documentView, setDocumentView] = useState<DocumentManagementView>('generated')
  const { myPermission, fetchMyPermission } = useKnowledgePermissions({ kbId: wiki.id })

  useEffect(() => {
    if (user) void fetchMyPermission()
  }, [fetchMyPermission, user, wiki.id])

  const permissions = useMemo(() => {
    if (!user) {
      return { canManageKb: false, canManageDocuments: false, canManagePermissions: false }
    }

    const permissionArgs = {
      currentUserId: user.id,
      knowledgeBase: wiki,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(wiki.namespace),
    }
    return {
      canManageKb: canManageKnowledgeBase(permissionArgs),
      canManageDocuments: canManageKnowledgeBaseDocuments(permissionArgs),
      canManagePermissions: canManageKnowledgeBasePermissions(permissionArgs),
    }
  }, [myPermission?.role, namespaceRoleMap, user, wiki])

  const contentTabs = (
    <Tabs
      value={documentView}
      onValueChange={next => setDocumentView(next as DocumentManagementView)}
      className="flex-shrink-0"
    >
      <TabsList className="h-8" data-testid="code-wiki-content-roots">
        <TabsTrigger
          value="generated"
          className="h-7 gap-1 px-2 text-xs"
          data-testid="code-wiki-content-generated"
        >
          <Library className="h-3.5 w-3.5" />
          {t('codeWiki.workspace.generatedContent')}
        </TabsTrigger>
        <TabsTrigger
          value="user"
          className="h-7 gap-1 px-2 text-xs"
          data-testid="code-wiki-content-user"
        >
          <FileText className="h-3.5 w-3.5" />
          {t('codeWiki.workspace.userContent')}
        </TabsTrigger>
        {permissions.canManagePermissions && (
          <TabsTrigger
            value="permissions"
            className="h-7 gap-1 px-2 text-xs"
            data-testid="code-wiki-content-permissions"
          >
            <Shield className="h-3.5 w-3.5" />
            {t('codeWiki.workspace.permissions')}
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="code-wiki-workspace">
      {view === 'wiki' ? (
        <CodeWikiReader wiki={wiki} canConfigure={canConfigure} onConfigure={onConfigure} />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"
          data-testid="code-wiki-document-management"
        >
          {documentView === 'permissions' ? (
            <>
              <div className="mb-4 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {groupInfo && (
                      <>
                        <button
                          type="button"
                          onClick={() => onGroupClick?.(groupInfo.groupId, groupInfo.groupType)}
                          className="max-w-[120px] truncate text-base font-medium text-text-secondary transition-colors hover:text-primary"
                          title={groupInfo.groupName}
                        >
                          {groupInfo.groupName}
                        </button>
                        <span className="text-text-muted">/</span>
                      </>
                    )}
                    <h2 className="truncate text-base font-medium text-text-primary">
                      {wiki.name}
                    </h2>
                  </div>
                </div>
                {contentTabs}
              </div>
              <PermissionManagementTab kbId={wiki.id} kbNamespace={wiki.namespace} />
            </>
          ) : (
            <DocumentList
              key={`${wiki.id}-${documentView}`}
              knowledgeBase={wiki}
              contentOrigin={documentView}
              readOnly={documentView === 'generated'}
              canUpload={documentView === 'user' && permissions.canManageDocuments}
              canManageAllDocuments={documentView === 'user' && permissions.canManageKb}
              paginationEnabled={true}
              headerActions={contentTabs}
              groupInfo={groupInfo}
              onGroupClick={onGroupClick}
            />
          )}
        </div>
      )}
    </div>
  )
}
