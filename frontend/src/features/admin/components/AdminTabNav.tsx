// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { Users, Cpu, Settings } from 'lucide-react';

export type AdminTabId = 'users' | 'public-models' | 'system-config';

interface AdminTabNavProps {
  activeTab: AdminTabId;
  onTabChange: (tab: AdminTabId) => void;
}

interface TabItem {
  id: AdminTabId;
  label: string;
  icon: React.ElementType;
}

export function AdminTabNav({ activeTab, onTabChange }: AdminTabNavProps) {
  const { t } = useTranslation('admin');
  const isMobile = useIsMobile();
  const indicatorContainerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicatorStyle, setIndicatorStyle] = useState({ width: 0, left: 0 });

  // Tab items
  const tabs: TabItem[] = [
    { id: 'users', label: t('tabs.users'), icon: Users },
    { id: 'public-models', label: t('tabs.public_models'), icon: Cpu },
    { id: 'system-config', label: t('tabs.system_config'), icon: Settings },
  ];

  // Update the indicator position when the active tab changes
  useEffect(() => {
    const updateIndicator = () => {
      const container = indicatorContainerRef.current;
      const current = itemRefs.current[activeTab];

      if (!container || !current) {
        setIndicatorStyle(prev =>
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
  }, [activeTab]);

  // Mobile: Dropdown select
  if (isMobile) {
    return (
      <div className="px-4 py-2 border-t border-border bg-white">
        <Select value={activeTab} onValueChange={value => onTabChange(value as AdminTabId)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('tabs.users')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {tabs.map(tab => (
                <SelectItem key={tab.id} value={tab.id}>
                  <div className="flex items-center gap-2">
                    <tab.icon className="w-4 h-4" />
                    {tab.label}
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Desktop: Horizontal tab navigation
  return (
    <div
      ref={indicatorContainerRef}
      className="relative flex items-center gap-1 px-4 py-2 border-t border-border bg-white overflow-x-auto"
    >
      {/* Sliding indicator */}
      <span
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-all duration-300 ease-out"
        style={{
          width: indicatorStyle.width,
          left: indicatorStyle.left,
          opacity: indicatorStyle.width ? 1 : 0,
        }}
        aria-hidden="true"
      />

      {/* Tab buttons */}
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          ref={element => {
            itemRefs.current[tab.id] = element;
          }}
          onClick={() => onTabChange(tab.id)}
          className={`relative flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200 ${
            activeTab === tab.id
              ? 'text-primary bg-primary/10'
              : 'text-text-secondary hover:text-text-primary hover:bg-muted'
          }`}
          aria-current={activeTab === tab.id ? 'page' : undefined}
        >
          <tab.icon className="w-4 h-4" />
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default AdminTabNav;
