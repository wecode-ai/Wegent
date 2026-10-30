// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter, usePathname } from 'next/navigation'
import { CollaborationTemplatePage } from '@wegent/collaboration/templates'
import { CollaborationTheme, useDocumentTheme } from '@wegent/collaboration/theme'
import '@wegent/collaboration/styles.css'
import { useTranslation } from '@/hooks/useTranslation'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import { useCollaborationTemplates } from './useCollaborationTemplates'

export function CollaborationTemplateMarketplace() {
  const { t, i18n } = useTranslation('resource-library')
  const router = useRouter()
  const pathname = usePathname()
  const theme = useDocumentTheme()
  const store = useCollaborationTemplates()
  return (
    <main
      className="h-full overflow-y-auto bg-base text-text-primary"
      data-testid="resource-library-template-marketplace"
    >
      <div className="mx-auto w-full max-w-[1600px] px-4 pb-8 pt-5 sm:px-6 lg:px-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('template_description')}</p>
        </header>
        <ResourceTypeFilter
          value="template"
          filters={['agent', 'skill', 'mcp', 'template']}
          marketLabels
          onValueChange={value => router.replace(`${pathname}?type=${value}`)}
        />
        {store && (
          <CollaborationTheme mode={theme}>
            <CollaborationTemplatePage
              key={store.library.scope}
              store={store}
              locale={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
              mode="marketplace"
            />
          </CollaborationTheme>
        )}
      </div>
    </main>
  )
}
