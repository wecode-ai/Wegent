// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from '@/hooks/useTranslation'
import { ShieldCheck } from 'lucide-react'
import type { MyPermissionSourcesResponse } from '@/types/knowledge'

/** Explain server-provided permissions without inferring authorization from their labels. */
export function KnowledgePermissionSources({
  permission,
}: {
  permission: MyPermissionSourcesResponse
}) {
  const { t } = useTranslation('knowledge')
  const labels = 'document.navigation.permissionSourceLabels'
  const permissionLabel = (role: NonNullable<MyPermissionSourcesResponse['effective_role']>) =>
    t(`document.navigation.permissionResult.${role}`)
  const hasCreatorIdentity =
    permission.is_creator || permission.sources.some(source => source.source_type === 'creator')
  const describeSource = (source: MyPermissionSourcesResponse['sources'][number]) => {
    let key: string
    switch (source.source_type) {
      case 'direct':
        key = 'direct'
        break
      case 'share_link':
        key = 'shareLink'
        break
      case 'group_membership':
        key = 'groupMembership'
        break
      case 'organization':
        key = 'organization'
        break
      case 'entity_permission':
        key =
          source.entity_type === 'org_department'
            ? 'department'
            : source.entity_type === 'namespace'
              ? 'groupGrant'
              : 'other'
        break
      default:
        key = 'other'
    }
    const role =
      source.source_type === 'group_membership' && source.role === 'Owner'
        ? t(`${labels}.groupOwner`)
        : permissionLabel(source.role)
    return t(`${labels}.withRole`, {
      source: t(`${labels}.${key}`, { name: source.display_name || t(`${labels}.unnamed`) }),
      role,
    })
  }
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:gap-5">
      <div
        className="flex shrink-0 items-center gap-3 sm:w-40"
        data-testid="knowledge-effective-permission"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-xs text-text-secondary">
            {t('document.navigation.effectivePermission')}
          </p>
          <p className="mt-1 text-2xl font-semibold leading-tight text-text-primary">
            {permission.effective_role ? permissionLabel(permission.effective_role) : '—'}
          </p>
        </div>
      </div>
      <div className="min-w-0 flex-1 border-t border-border pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
        <h3 className="mb-2 text-xs font-medium text-text-muted">{t(`${labels}.title`)}</h3>
        <ul
          className="list-disc space-y-1.5 break-words pl-4 text-sm leading-relaxed text-text-secondary marker:text-text-muted"
          data-testid="knowledge-permission-sources"
        >
          {hasCreatorIdentity && <li>{t(`${labels}.creator`)}</li>}
          {permission.sources
            .filter(source => source.source_type !== 'creator')
            .map((source, index) => (
              <li
                key={JSON.stringify([
                  source.source_type,
                  source.entity_type,
                  source.entity_id,
                  index,
                ])}
              >
                {describeSource(source)}
              </li>
            ))}
        </ul>
      </div>
    </section>
  )
}
