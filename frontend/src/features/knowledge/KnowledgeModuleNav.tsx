// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from '@/hooks/useTranslation';
import { CodeBracketIcon } from '@heroicons/react/24/outline';

export type KnowledgeModule = 'code' | 'wiki';

interface KnowledgeModuleNavProps {
  activeModule?: KnowledgeModule;
}

interface ModuleItem {
  id: KnowledgeModule;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  description?: string;
}

const modules: ModuleItem[] = [
  {
    id: 'code',
    labelKey: 'knowledge.modules.code',
    icon: CodeBracketIcon,
    href: '/knowledge',
    description: 'knowledge.modules.code_desc',
  },
  // Future modules can be added here
  // {
  //   id: 'wiki',
  //   labelKey: 'knowledge.modules.wiki',
  //   icon: BookOpenIcon,
  //   href: '/knowledge/wiki',
  //   description: 'knowledge.modules.wiki_desc',
  // },
];

/**
 * Knowledge module navigation sidebar component
 * Displays navigation for different knowledge modules (Code Knowledge, Wiki, etc.)
 */
export function KnowledgeModuleNav({ activeModule }: KnowledgeModuleNavProps) {
  const { t } = useTranslation('common');
  const pathname = usePathname();

  // Determine active module from pathname if not provided
  const currentModule = activeModule || (pathname?.includes('/knowledge/wiki') ? 'wiki' : 'code');

  return (
    <div className="w-56 border-r border-border bg-surface h-full flex flex-col">
      <div className="p-4">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">
          {t('knowledge.modules.title')}
        </h2>
        <nav className="space-y-1">
          {modules.map(module => {
            const isActive = currentModule === module.id;
            const Icon = module.icon;

            return (
              <Link
                key={module.id}
                href={module.href}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors
                  ${
                    isActive
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }
                `}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-primary' : ''}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">{t(module.labelKey)}</span>
                  {module.description && (
                    <span className="text-xs text-text-muted truncate">
                      {t(module.description)}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
