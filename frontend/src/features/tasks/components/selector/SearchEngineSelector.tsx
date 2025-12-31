// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useMemo } from 'react';
import { Globe, Check, ChevronDown, GlobeOff, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown';
import { cn } from '@/lib/utils';
import { SearchEngine } from '@/apis/chat';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Web search mode types:
 * - auto: AI decides whether to search (default behavior)
 * - on: Force search with specified engine
 * - off: Disable search completely
 */
export type WebSearchMode = 'auto' | 'on' | 'off';

interface SearchEngineSelectorProps {
  mode: WebSearchMode;
  onModeChange: (mode: WebSearchMode) => void;
  selectedEngine: string | null;
  onSelectEngine: (engine: string) => void;
  disabled?: boolean;
  engines: SearchEngine[];
  /** When true, hide engine name and show only icon (for responsive collapse) */
  compact?: boolean;
}

export default function SearchEngineSelector({
  mode,
  onModeChange,
  selectedEngine,
  onSelectEngine,
  disabled = false,
  engines,
}: SearchEngineSelectorProps) {
  const { t } = useTranslation('chat');

  // Initialize selected engine if not set and engines are available
  useEffect(() => {
    if (!selectedEngine && engines.length > 0) {
      onSelectEngine(engines[0].name);
    }
  }, [engines, selectedEngine, onSelectEngine]);

  const currentEngine = useMemo(() => {
    return engines.find(e => e.name === selectedEngine) || engines[0];
  }, [engines, selectedEngine]);

  // Get mode display info
  const getModeInfo = (modeValue: WebSearchMode) => {
    switch (modeValue) {
      case 'auto':
        return {
          icon: <Sparkles className="h-4 w-4" />,
          label: t('web_search.mode_auto'),
          desc: t('web_search.mode_auto_desc'),
          color: 'text-text-muted hover:bg-surface hover:text-text-primary',
        };
      case 'on':
        return {
          icon: <Globe className="h-4 w-4" />,
          label: t('web_search.mode_on'),
          desc: t('web_search.mode_on_desc'),
          color: 'bg-primary/10 text-primary hover:bg-primary/20',
        };
      case 'off':
        return {
          icon: <GlobeOff className="h-4 w-4" />,
          label: t('web_search.mode_off'),
          desc: t('web_search.mode_off_desc'),
          color: 'text-text-muted hover:bg-surface hover:text-text-primary',
        };
    }
  };

  const currentModeInfo = getModeInfo(mode);

  const handleModeSelect = (newMode: WebSearchMode) => {
    onModeChange(newMode);
  };

  const handleEngineSelect = (engineName: string) => {
    onSelectEngine(engineName);
    // When selecting an engine, also set mode to 'on'
    if (mode !== 'on') {
      onModeChange('on');
    }
  };

  if (engines.length === 0) {
    // Fallback if no engines configured but feature is enabled
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onModeChange(mode === 'off' ? 'auto' : 'off')}
              disabled={disabled}
              className={cn(
                'h-8 w-8 rounded-lg flex-shrink-0 transition-colors',
                currentModeInfo.color
              )}
            >
              {currentModeInfo.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{currentModeInfo.label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <div
                className={cn(
                  'flex items-center h-8 rounded-lg transition-colors border border-transparent cursor-pointer px-2 gap-1',
                  currentModeInfo.color,
                  disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
                )}
              >
                {currentModeInfo.icon}
                <ChevronDown className="h-3 w-3 opacity-70" />
              </div>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {currentModeInfo.label}
              {mode === 'on' && currentEngine ? ` - ${currentEngine.display_name}` : ''}
            </p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-[220px]">
          {/* Mode selection section */}
          <DropdownMenuLabel className="text-xs text-text-muted font-normal">
            {t('web_search.select_mode')}
          </DropdownMenuLabel>
          {(['auto', 'on', 'off'] as WebSearchMode[]).map(modeValue => {
            const modeInfo = getModeInfo(modeValue);
            return (
              <DropdownMenuItem
                key={modeValue}
                onClick={() => handleModeSelect(modeValue)}
                className="flex items-center justify-between cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  {modeInfo.icon}
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{modeInfo.label}</span>
                    <span className="text-xs text-text-muted">{modeInfo.desc}</span>
                  </div>
                </div>
                {mode === modeValue && <Check className="h-4 w-4 text-primary" />}
              </DropdownMenuItem>
            );
          })}

          {/* Engine selection section - only show when mode is 'on' or has engines */}
          {engines.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-text-muted font-normal">
                {t('web_search.select_engine')}
              </DropdownMenuLabel>
              {engines.map(engine => (
                <DropdownMenuItem
                  key={engine.name}
                  onClick={() => handleEngineSelect(engine.name)}
                  className="flex items-center justify-between cursor-pointer"
                >
                  <span className="text-sm">{engine.display_name}</span>
                  {selectedEngine === engine.name && <Check className="h-4 w-4 text-primary" />}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}
