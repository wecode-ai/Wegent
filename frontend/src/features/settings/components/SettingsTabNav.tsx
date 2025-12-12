// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';

export type SettingsTabId =
  | 'personal-models'
  | 'personal-shells'
  | 'personal-team'
  | 'group-manager'
  | 'group-models'
  | 'group-shells'
  | 'group-team'
  | 'skills'
  | 'integrations'
  | 'general';

interface SettingsTabNavProps {
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
}

interface TabItem {
  id: SettingsTabId;
  label: string;
  group?: string;
}

export function SettingsTabNav({ activeTab, onTabChange }: SettingsTabNavProps) {
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const indicatorContainerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicatorStyle, setIndicatorStyle] = useState({ width: 0, left: 0 });

  const tabs: TabItem[] = [
    { id: 'personal-models', label: t('settings.models'), group: t('settings.personal') },
    { id: 'personal-shells', label: t('settings.shells'), group: t('settings.personal') },
    { id: 'personal-team', label: t('settings.team'), group: t('settings.personal') },
    { id: 'group-manager', label: t('settings.groupManager'), group: t('settings.groups') },
    { id: 'group-models', label: t('settings.models'), group: t('settings.groups') },
    { id: 'group-shells', label: t('settings.shells'), group: t('settings.groups') },
    { id: 'group-team', label: t('settings.team'), group: t('settings.groups') },
    { id: 'skills', label: t('skills.title') },
    { id: 'integrations', label: t('settings.integrations') },
    { id: 'general', label: t('settings.sections.general') },
  ];

  // Update the indicator position when the active tab changes
  useEffect(() => {
    const updateIndicator = () => {
      const container = indicatorContainerRef.current;
      const current = itemRefs.current[activeTab];

      if (!container || !current) {
        setIndicatorStyle((prev) =>
          prev.width === 0 && prev.left === 0 ? prev : { width: 0, left: 0 }
        );
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const currentRect = current.getBoundingClientRect();
      setIndicatorStyle({
        width: currentRect.width,
        left: currentRect.left - containerRect.left,
      });
    };

    updateIndicator();
    window.addEventListener('resize', updateIndicator);

    return () => {
      window.removeEventListener('resize', updateIndicator);
    };
  }, [activeTab, tabs]);

  // Get the label for display in the mobile select
  const getTabDisplayLabel = (tab: TabItem): string => {
    if (tab.group) {
      return `${tab.group} - ${tab.label}`;
    }
    return tab.label;
  };

  // Mobile: Dropdown select
  if (isMobile) {
    return (
      <div className="px-4 py-2 border-b border-border bg-surface">
        <Select value={activeTab} onValueChange={(value) => onTabChange(value as SettingsTabId)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('settings.sections.general')} />
          </SelectTrigger>
          <SelectContent>
            {tabs.map((tab) => (
              <SelectItem key={tab.id} value={tab.id}>
                {getTabDisplayLabel(tab)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Desktop: Horizontal tab navigation with indicator
  return (
    <div
      ref={indicatorContainerRef}
      className="relative flex items-center gap-1 px-4 py-2 border-b border-border bg-surface overflow-x-auto"
    >
      {/* Sliding indicator */}
      <span
        className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-primary transition-all duration-300 ease-out"
        style={{
          width: indicatorStyle.width,
          transform: `translateX(${indicatorStyle.left}px)`,
          opacity: indicatorStyle.width ? 1 : 0,
        }}
        aria-hidden="true"
      />

      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          ref={(element) => {
            itemRefs.current[tab.id] = element;
          }}
          onClick={() => onTabChange(tab.id)}
          className={`relative px-3 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200 ${
            activeTab === tab.id
              ? 'text-primary bg-primary/10'
              : 'text-text-secondary hover:text-text-primary hover:bg-muted'
          }`}
          aria-current={activeTab === tab.id ? 'page' : undefined}
        >
          {tab.group ? (
            <span className="flex items-center gap-1">
              <span className="text-xs text-text-muted">{tab.group}</span>
              <span>/</span>
              <span>{tab.label}</span>
            </span>
          ) : (
            tab.label
          )}
        </button>
      ))}
    </div>
  );
}

export default SettingsTabNav;
