// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import * as LucideIcons from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

// Common icons for team selection (curated list of ~60 icons)
const COMMON_ICONS = [
  'Users',
  'Bot',
  'Zap',
  'Rocket',
  'Star',
  'Heart',
  'Brain',
  'Lightbulb',
  'Code',
  'Terminal',
  'Database',
  'Server',
  'Cloud',
  'Globe',
  'Network',
  'Cpu',
  'Sparkles',
  'Wand2',
  'Magic',
  'Target',
  'Award',
  'Trophy',
  'Medal',
  'Crown',
  'Building',
  'Home',
  'Briefcase',
  'Folder',
  'FileCode',
  'GitBranch',
  'Github',
  'Gitlab',
  'MessageSquare',
  'MessagesSquare',
  'Mail',
  'Send',
  'Phone',
  'Video',
  'Mic',
  'Headphones',
  'Search',
  'Eye',
  'Settings',
  'Wrench',
  'Hammer',
  'Puzzle',
  'Layers',
  'Layout',
  'Palette',
  'Paintbrush',
  'PenTool',
  'Image',
  'Camera',
  'Film',
  'Music',
  'Play',
  'Shield',
  'Lock',
  'Key',
  'Fingerprint',
  'UserCheck',
  'UserPlus',
  'Users2',
  'UsersRound',
];

interface IconPickerProps {
  value?: string;
  onChange: (icon: string) => void;
  disabled?: boolean;
  className?: string;
  teamName?: string;
}

export default function IconPicker({
  value,
  onChange,
  disabled = false,
  className,
  teamName = '',
}: IconPickerProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Get the icon component dynamically
  const IconComponent = value
    ? (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[value]
    : null;

  // Filter icons based on search
  const filteredIcons = useMemo(() => {
    if (!search.trim()) return COMMON_ICONS;
    const searchLower = search.toLowerCase();
    return COMMON_ICONS.filter(icon => icon.toLowerCase().includes(searchLower));
  }, [search]);

  // Get first letter for default avatar
  const firstLetter = teamName.trim().charAt(0).toUpperCase() || 'T';

  const handleIconSelect = (iconName: string) => {
    onChange(iconName);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          disabled={disabled}
          className={cn(
            'h-9 w-9 rounded-md border-border hover:border-primary transition-colors',
            className
          )}
          title={t('teams.select_icon')}
        >
          {IconComponent ? (
            <IconComponent className="h-5 w-5 text-primary" />
          ) : (
            <span className="text-sm font-medium text-text-muted">{firstLetter}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-3">
          <Input
            placeholder={t('actions.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8"
          />
          <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
            {filteredIcons.map(iconName => {
              const Icon = (
                LucideIcons as unknown as Record<
                  string,
                  React.ComponentType<{ className?: string }>
                >
              )[iconName];
              if (!Icon) return null;
              const isSelected = value === iconName;
              return (
                <Button
                  key={iconName}
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-8 w-8 rounded-md',
                    isSelected && 'bg-primary/10 text-primary border border-primary'
                  )}
                  onClick={() => handleIconSelect(iconName)}
                  title={iconName}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              );
            })}
          </div>
          {filteredIcons.length === 0 && (
            <p className="text-sm text-text-muted text-center py-2">{t('teams.no_match')}</p>
          )}
          {value && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-text-muted"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {t('actions.reset')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
