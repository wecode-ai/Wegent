// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { KnowledgeGrantForm } from '@extensions/knowledge-permissions'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

import { useTranslation } from '@/hooks/useTranslation'
import type { PermissionListResponse } from '@/types/knowledge'
import { KnowledgeGrantDialog } from './KnowledgeGrantDialog'
import { PermissionRequests } from './PermissionRequests'
import {
  PermissionManagementScope,
  usePermissionManagementController,
  type PermissionManagementProps,
  type PermissionManagementSessionProps,
} from './permission-management-controller'

import { KnowledgeAuthorizationRow, type AuthorizationRow } from './KnowledgeAuthorizationRow'

function authorizationRows(permissions: PermissionListResponse): AuthorizationRow[] {
  const creator = permissions.creator
  return [
    ...(creator
      ? [
          {
            key: 'creator',
            name: creator.display_name,
            type: 'user',
            role: 'Owner' as const,
            source: 'creator' as const,
          },
        ]
      : []),
    ...(permissions.inherited_sources ?? []).map(source => ({
      key: `inherited:${source.source_type}:${source.entity_id}`,
      name: source.display_name || source.entity_id,
      type: source.entity_type,
      role: source.role,
      source: 'inherited' as const,
      inheritedType: source.source_type,
    })),
    ...Object.values(permissions.approved)
      .flat()
      .map(member => ({
        key: `member:${member.id}`,
        name: member.display_name || member.entity_id || String(member.user_id),
        type: member.entity_type || 'user',
        role: member.role,
        source: 'direct' as const,
        memberId: member.id,
        inviterName: member.invited_by_name,
      })),
  ]
}

export function KnowledgeAuthorizationObjects(props: PermissionManagementProps) {
  return (
    <PermissionManagementScope {...props}>
      {session => <AuthorizationSession {...session} />}
    </PermissionManagementScope>
  )
}

function AuthorizationSession(props: PermissionManagementSessionProps) {
  const { t } = useTranslation('knowledge')
  const actions = usePermissionManagementController(props)
  const { permissions, loading, error, fetchPermissions } = actions
  const [showAdd, setShowAdd] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const canManage = props.canManage === true
  useEffect(() => {
    if (!canManage) setShowAdd(false)
  }, [canManage])
  const text = 'document.authorizationObjects'
  const retry = (
    <Button
      variant="outline"
      className="min-h-11 min-w-11"
      data-testid="retry-knowledge-members"
      onClick={() => void fetchPermissions()}
    >
      {t('document.navigation.retry')}
    </Button>
  )
  if (!permissions)
    return (
      <div role={error ? 'alert' : 'status'}>
        {error ? (
          <>
            <p>{t('document.navigation.membersFailed')}</p>
            {retry}
          </>
        ) : (
          <Spinner />
        )}
      </div>
    )
  const rows = authorizationRows(permissions)
  const boundNamespaceIds = Object.values(permissions.approved)
    .flat()
    .filter(member => member.entity_type === 'namespace')
    .flatMap(member => (member.entity_id ? [member.entity_id] : []))
  const mutate = async (operation: () => Promise<unknown>) => {
    if (!canManage) return
    try {
      await operation()
    } catch {
      /* The shared controller exposes mutation errors. */
    }
  }
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border pt-5"
      data-testid="knowledge-authorization-objects"
    >
      <div data-testid="collaborator-list" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3
              className="text-sm font-semibold text-text-primary"
              data-testid="knowledge-member-count"
            >
              {t(`${text}.title`)}{' '}
              <span className="ml-1 text-xs font-normal text-text-muted">
                {t(`${text}.count`, { count: rows.length })}
              </span>
            </h3>
            <p className="mt-1 text-xs text-text-muted">{t(`${text}.description`)}</p>
          </div>
          {canManage && (
            <Button
              ref={trigger}
              variant="primary"
              className="min-h-11 min-w-11 gap-1.5"
              data-testid="permission-add-collaborator"
              aria-label={t('document.permission.addCollaborator')}
              onClick={() => setShowAdd(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span className="md:hidden">{t('document.permission.add')}</span>
              <span className="hidden md:inline">{t('document.permission.addCollaborator')}</span>
            </Button>
          )}
        </div>
        {error && (
          <div role="alert">
            <p>{t('document.navigation.membersFailed')}</p>
            {retry}
          </div>
        )}
        {canManage && (
          <PermissionRequests
            roles={actions.approvalRoles}
            onRoleChange={actions.setApprovalRole}
            pending={permissions.pending}
            loading={loading}
            onReview={actions.reviewPermission}
          />
        )}
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface text-xs text-text-muted">
              <tr>
                <th className="px-3 py-3 font-medium">{t(`${text}.object`)}</th>
                <th className="px-3 py-3 font-medium">{t(`${text}.permission`)}</th>
                <th className="px-3 py-3 font-medium">{t(`${text}.source`)}</th>
                {canManage && (
                  <th
                    className="px-3 py-3 text-right font-medium"
                    data-testid="knowledge-authorization-actions"
                  >
                    {t(`${text}.actions`)}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <KnowledgeAuthorizationRow
                  key={row.key}
                  row={row}
                  canManage={canManage}
                  loading={loading}
                  onRole={(id, role) => void mutate(() => actions.updatePermission(id, role))}
                  onRemove={id => void mutate(() => actions.deletePermission(id))}
                />
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <p className="text-sm text-text-muted">{t(`${text}.empty`)}</p>}
        <p className="text-xs leading-relaxed text-text-muted">{t(`${text}.membershipNote`)}</p>
        {rows.some(row => row.inheritedType === 'organization') && (
          <p className="text-xs text-text-muted">{t(`${text}.organizationNote`)}</p>
        )}
        {!canManage && <p className="text-xs text-text-muted">{t(`${text}.readOnlyNote`)}</p>}
        {showAdd && canManage && (
          <KnowledgeGrantDialog trigger={trigger} onClose={() => setShowAdd(false)}>
            <KnowledgeGrantForm
              kbId={props.kbId}
              kbNamespace={props.kbNamespace}
              boundNamespaceIds={boundNamespaceIds}
              onChanged={actions.membersChanged}
              onAccessDenied={props.onAccessDenied}
              onCancel={() => setShowAdd(false)}
            />
          </KnowledgeGrantDialog>
        )}
      </div>
    </section>
  )
}
