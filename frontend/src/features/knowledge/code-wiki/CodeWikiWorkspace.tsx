// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Library, Shield } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { useUser } from '@/features/common/UserContext'
import { DocumentList } from '@/features/knowledge/document/components/DocumentList'
import { KnowledgeAccessDialog } from '@/features/knowledge/document/components/KnowledgeAccessDialog'
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
  const [documentView, setDocumentView] = useState<KnowledgeContentOrigin>('generated')
  const [permissionKbId, setPermissionKbId] = useState<number | null>(null)
  const permissionTrigger = useRef<HTMLButtonElement>(null)
  const documentRegion = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setPermissionKbId(null)
  }, [wiki.id, view])
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
    <div className="flex shrink-0 items-center gap-2">
      <Tabs
        value={documentView}
        onValueChange={next => setDocumentView(next as KnowledgeContentOrigin)}
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
        </TabsList>
      </Tabs>
      {permissions.canManagePermissions && (
        <Button
          ref={permissionTrigger}
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={permissionKbId === wiki.id}
          data-testid="code-wiki-content-permissions"
          className="h-11 min-h-11 min-w-11 gap-1 px-2 text-xs md:h-8 md:min-h-8"
          onClick={() => setPermissionKbId(wiki.id)}
        >
          <Shield className="h-3.5 w-3.5" />
          {t('codeWiki.workspace.permissions')}
        </Button>
      )}
    </div>
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
          ref={documentRegion}
          tabIndex={-1}
        >
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
          {permissionKbId === wiki.id && (
            <KnowledgeAccessDialog
              kbId={wiki.id}
              kbNamespace={wiki.namespace}
              canManage={permissions.canManagePermissions}
              restoreFocus={() => (permissionTrigger.current ?? documentRegion.current)?.focus()}
              onClose={() => setPermissionKbId(null)}
              onChanged={onPermissionsChanged ?? (() => void fetchMyPermission())}
              onAccessLost={() => {
                setPermissionKbId(null)
                onAccessLost?.()
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
