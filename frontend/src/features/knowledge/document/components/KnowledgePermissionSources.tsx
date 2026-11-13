// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from '@/hooks/useTranslation'
import type { MyPermissionSourcesResponse } from '@/types/knowledge'

export function KnowledgePermissionSources({
  permission,
}: {
  permission: MyPermissionSourcesResponse
}) {
  const { t } = useTranslation('knowledge')
  return (
    <section>
      <p>
        {t('document.navigation.effectivePermission')}:{' '}
        {permission.effective_role
          ? t(`document.permission.role.${permission.effective_role}`)
          : '—'}
      </p>
      <ul className="space-y-2" data-testid="knowledge-permission-sources">
        {permission.sources.map((source, index) => (
          <li
            key={JSON.stringify([source.source_type, source.entity_type, source.entity_id, index])}
            className="flex flex-wrap justify-between gap-2 break-words text-sm"
          >
            <span>{source.display_name || t('document.navigation.permissionSource')}</span>
            <span>{t(`document.permission.role.${source.role}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
