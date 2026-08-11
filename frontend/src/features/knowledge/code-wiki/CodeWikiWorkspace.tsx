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
import type { KnowledgeBase, KnowledgeContentOrigin } from '@/types/knowledge'
import { CodeWikiReader } from './CodeWikiReader'

type CodeWikiView = 'wiki' | 'documents'
type DocumentManagementView = KnowledgeContentOrigin | 'permissions'

interface CodeWikiWorkspaceProps {
  wiki: KnowledgeBase
  canConfigure?: boolean
  onConfigure?: () => void
}

/**
 * The two product views of a Code Wiki share one knowledge-base identity.
 *
 * Wiki reads only the generation projection. Document Management surfaces the
 * same KB's two virtual content roots without encoding either root into paths.
 */
export function CodeWikiWorkspace({
  wiki,
  canConfigure = false,
  onConfigure,
}: CodeWikiWorkspaceProps) {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()
  const namespaceRoleMap = useNamespaceRoleMap()
  const [view, setView] = useState<CodeWikiView>('wiki')
  const [documentView, setDocumentView] = useState<DocumentManagementView>('user')
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
      className="w-full"
    >
      <TabsList
        className={`grid h-11 w-full ${permissions.canManagePermissions ? 'grid-cols-3' : 'grid-cols-2'}`}
        data-testid="code-wiki-content-roots"
      >
        <TabsTrigger
          value="generated"
          className="h-11 gap-1.5"
          data-testid="code-wiki-content-generated"
        >
          <Library className="h-4 w-4" />
          {t('codeWiki.workspace.generatedContent')}
        </TabsTrigger>
        <TabsTrigger value="user" className="h-11 gap-1.5" data-testid="code-wiki-content-user">
          <FileText className="h-4 w-4" />
          {t('codeWiki.workspace.userContent')}
        </TabsTrigger>
        {permissions.canManagePermissions && (
          <TabsTrigger
            value="permissions"
            className="h-11 gap-1.5"
            data-testid="code-wiki-content-permissions"
          >
            <Shield className="h-4 w-4" />
            {t('codeWiki.workspace.permissions')}
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="code-wiki-workspace">
      <Tabs value={view} onValueChange={next => setView(next as CodeWikiView)}>
        <TabsList className="grid h-11 w-full grid-cols-2 border-b border-border bg-base px-2">
          <TabsTrigger value="wiki" className="h-11" data-testid="code-wiki-view-wiki">
            {t('codeWiki.workspace.wiki')}
          </TabsTrigger>
          <TabsTrigger value="documents" className="h-11" data-testid="code-wiki-view-documents">
            {t('codeWiki.workspace.documents')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === 'wiki' ? (
        <CodeWikiReader wiki={wiki} canConfigure={canConfigure} onConfigure={onConfigure} />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"
          data-testid="code-wiki-document-management"
        >
          <div className="mb-4">{contentTabs}</div>
          {documentView === 'permissions' ? (
            <PermissionManagementTab kbId={wiki.id} kbNamespace={wiki.namespace} />
          ) : (
            <DocumentList
              key={`${wiki.id}-${documentView}`}
              knowledgeBase={wiki}
              contentOrigin={documentView}
              readOnly={documentView === 'generated'}
              canUpload={documentView === 'user' && permissions.canManageDocuments}
              canManageAllDocuments={documentView === 'user' && permissions.canManageKb}
              paginationEnabled={true}
            />
          )}
        </div>
      )}
    </div>
  )
}
