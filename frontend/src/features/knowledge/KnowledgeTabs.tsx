// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useTranslation } from '@/hooks/useTranslation';
import { CodeBracketIcon, DocumentTextIcon } from '@heroicons/react/24/outline';

export type KnowledgeTabType = 'code' | 'document';

interface KnowledgeTabItem {
  id: KnowledgeTabType;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  comingSoon?: boolean;
}

interface KnowledgeTabsProps {
  activeTab: KnowledgeTabType;
  onTabChange: (tab: KnowledgeTabType) => void;
}

const tabs: KnowledgeTabItem[] = [
  {
    id: 'code',
    labelKey: 'knowledge.tabs.code',
    icon: CodeBracketIcon,
  },
  {
    id: 'document',
    labelKey: 'knowledge.tabs.document',
    icon: DocumentTextIcon,
    disabled: true,
    comingSoon: true,
  },
];

/**
 * Knowledge page tab navigation component
 * Displays tabs for different knowledge types (Code Knowledge, Document Knowledge, etc.)
 */
export function KnowledgeTabs({ activeTab, onTabChange }: KnowledgeTabsProps) {
  const { t } = useTranslation('common');

  return (
    <div className="border-b border-border bg-surface">
      <div className="flex items-center px-4">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              onClick={() => !tab.disabled && onTabChange(tab.id)}
              disabled={tab.disabled}
              className={`
                relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors
                ${
                  isActive
                    ? 'text-primary border-b-2 border-primary -mb-[1px]'
                    : tab.disabled
                      ? 'text-text-muted cursor-not-allowed'
                      : 'text-text-secondary hover:text-text-primary'
                }
              `}
            >
              <Icon className="w-4 h-4" />
              <span>{t(tab.labelKey)}</span>
              {tab.comingSoon && (
                <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted text-text-muted">
                  {t('common.coming_soon')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
