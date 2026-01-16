// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo } from 'react'
import { Globe, Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { cn } from '@/lib/utils'
import { SearchEngine } from '@/apis/chat'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface SearchEngineSelectorProps {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  selectedEngine: string | null
  onSelectEngine: (engine: string) => void
  disabled?: boolean
  engines: SearchEngine[]
  /** When true, hide engine name and show only icon (for responsive collapse) */
  compact?: boolean
}

export default function SearchEngineSelector({
  enabled,
  onToggle,
  selectedEngine,
  onSelectEngine,
  disabled = false,
  engines,
}: SearchEngineSelectorProps) {
  const { t } = useTranslation()

  // Initialize selected engine if not set and engines are available
  useEffect(() => {
    if (!selectedEngine && engines.length > 0) {
      onSelectEngine(engines[0].name)
    }
  }, [engines, selectedEngine, onSelectEngine])

  const currentEngine = useMemo(() => {
    return engines.find(e => e.name === selectedEngine) || engines[0]
  }, [engines, selectedEngine])

  // If no engines defined or only one engine defined (and no need for selection),
  // revert to simple toggle behavior appearance (but still wrapped in this component for consistency if needed)
  // However, requirements say "let user select search engine", so we provide the UI.

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    onToggle(!enabled)
  }

  const handleSelect = (engineId: string) => {
    onSelectEngine(engineId)
    if (!enabled) {
      onToggle(true)
    }
  }

  if (engines.length === 0) {
    // Fallback if no engines configured but feature is enabled (shouldn't happen based on env logic)
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onToggle(!enabled)}
              disabled={disabled}
              className={cn(
                'h-8 w-8 rounded-lg flex-shrink-0 transition-colors',
                enabled
                  ? 'bg-primary/10 text-primary hover:bg-primary/20'
                  : 'text-text-muted hover:bg-surface hover:text-text-primary'
              )}
            >
              <Globe className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{enabled ? t('chat:web_search.disable') : t('chat:web_search.enable')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <div
        className={cn(
          'flex items-center h-8 rounded-lg transition-colors border border-transparent',
          enabled
            ? 'bg-primary/10 text-primary hover:bg-primary/20'
            : 'text-text-muted hover:bg-surface hover:text-text-primary hover:border-border',
          disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleToggle}
              disabled={disabled}
              className="h-8 w-8 rounded-l-lg rounded-r-none hover:bg-transparent p-0"
            >
              <Globe className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{enabled ? t('chat:web_search.disable') : t('chat:web_search.enable')}</p>
          </TooltipContent>
        </Tooltip>

        <div className="h-4 w-[1px] bg-current opacity-20 mx-0" />

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild disabled={disabled}>
                <div className="h-8 px-1.5 flex items-center justify-center rounded-r-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer">
                  <ChevronDown className="h-3 w-3 opacity-70" />
                </div>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{currentEngine?.display_name || t('chat:web_search.select_engine')}</p>
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-[180px]">
            {engines.map(engine => (
              <DropdownMenuItem
                key={engine.name}
                onClick={() => handleSelect(engine.name)}
                className="flex items-center justify-between cursor-pointer"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{engine.display_name}</span>
                </div>
                {selectedEngine === engine.name && <Check className="h-4 w-4 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TooltipProvider>
  )
}
