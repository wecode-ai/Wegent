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
import { useTranslation } from '@/hooks/useTranslation'
import {
  canManageKnowledgeBase,
  canManageKnowledgeBaseDocuments,
  canManageKnowledgeBasePermissions,
} from '@/utils/namespace-permissions'
import { isManager, isEditor } from '@/types/base-role'
import type {
  MemberRole,
  CodeWikiView,
  KbGroupInfo,
  KnowledgeBase,
  KnowledgeContentOrigin,
} from '@/types/knowledge'
import { CodeWikiReader } from './CodeWikiReader'

type DocumentManagementView = KnowledgeContentOrigin | 'permissions'

interface CodeWikiWorkspaceProps {
  wiki: KnowledgeBase
  verifiedRole?: MemberRole | null
  permissionRefreshKey?: number
  onPermissionsChanged?: () => void
  onAccessLost?: () => void
  view: CodeWikiView
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
  verifiedRole,
  permissionRefreshKey = 0,
  onPermissionsChanged,
  onAccessLost,
  view,
  onConfigure,
  groupInfo,
  onGroupClick,
}: CodeWikiWorkspaceProps) {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()
  const [documentView, setDocumentView] = useState<DocumentManagementView>('generated')
  const { myPermission, fetchMyPermission } = useKnowledgePermissions({
    kbId: wiki.id,
    onAccessDenied: onAccessLost,
  })

  useEffect(() => {
    if (user) void fetchMyPermission()
  }, [fetchMyPermission, user, wiki.id, permissionRefreshKey, verifiedRole])

  useEffect(() => {
    if (myPermission && !myPermission.has_access) onAccessLost?.()
  }, [myPermission, onAccessLost])

  const permissions = useMemo(() => {
    if (!user || !myPermission?.has_access) {
      return { canManageKb: false, canManageDocuments: false, canManagePermissions: false }
    }

    const permissionArgs = {
      currentUserId: user.id,
      knowledgeBase: wiki,
      knowledgeRole: myPermission?.role,
    }
    return {
      canManageKb:
        (verifiedRole === undefined || isManager(verifiedRole)) &&
        canManageKnowledgeBase(permissionArgs),
      canManageDocuments:
        (verifiedRole === undefined || isEditor(verifiedRole)) &&
        canManageKnowledgeBaseDocuments(permissionArgs),
      canManagePermissions:
        (verifiedRole === undefined || isManager(verifiedRole)) &&
        canManageKnowledgeBasePermissions(permissionArgs),
    }
  }, [myPermission, user, wiki, verifiedRole])

  const contentOrigin: KnowledgeContentOrigin = documentView === 'user' ? 'user' : 'generated'
  const contentTabs = (
    <Tabs
      value={documentView}
      onValueChange={next => setDocumentView(next as DocumentManagementView)}
      className="flex-shrink-0"
    >
      <TabsList className="h-11 md:h-8" data-testid="code-wiki-content-roots">
        <TabsTrigger
          value="generated"
          className="min-h-11 min-w-11 gap-1 px-2 text-xs md:h-7 md:min-h-0 md:min-w-0"
          data-testid="code-wiki-content-generated"
        >
          <Library className="h-3.5 w-3.5" />
          {t('codeWiki.workspace.generatedContent')}
        </TabsTrigger>
        <TabsTrigger
          value="user"
          className="min-h-11 min-w-11 gap-1 px-2 text-xs md:h-7 md:min-h-0 md:min-w-0"
          data-testid="code-wiki-content-user"
        >
          <FileText className="h-3.5 w-3.5" />
          {t('codeWiki.workspace.userContent')}
        </TabsTrigger>
        {permissions.canManagePermissions && (
          <TabsTrigger
            value="permissions"
            className="min-h-11 min-w-11 gap-1 px-2 text-xs md:h-7 md:min-h-0 md:min-w-0"
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
        <CodeWikiReader
          wiki={wiki}
          canConfigure={permissions.canManageKb}
          onConfigure={onConfigure}
        />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"
          data-testid="code-wiki-document-management"
        >
          {documentView === 'permissions' && permissions.canManagePermissions ? (
            <>
              <div className="mb-4 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {groupInfo && (
                      <>
                        {onGroupClick ? (
                          <button
                            type="button"
                            onClick={() => onGroupClick(groupInfo.groupId, groupInfo.groupType)}
                            className="max-w-[120px] truncate text-base font-medium text-text-secondary transition-colors hover:text-primary"
                            title={groupInfo.groupName}
                            data-testid="code-wiki-group-navigation"
                          >
                            {groupInfo.groupName}
                          </button>
                        ) : (
                          <span
                            className="max-w-[120px] truncate text-base font-medium text-text-secondary"
                            title={groupInfo.groupName}
                          >
                            {groupInfo.groupName}
                          </span>
                        )}
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
              <PermissionManagementTab
                kbId={wiki.id}
                kbNamespace={wiki.namespace}
                onChanged={onPermissionsChanged ?? (() => void fetchMyPermission())}
                onAccessDenied={() => {
                  void fetchMyPermission()
                  onPermissionsChanged?.()
                }}
              />
            </>
          ) : (
            <DocumentList
              key={`${wiki.id}-${documentView}`}
              knowledgeBase={wiki}
              contentOrigin={contentOrigin}
              readOnly={contentOrigin === 'generated'}
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
