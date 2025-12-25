// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Check, FileText } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { knowledgeBaseApi } from '@/apis/knowledge-base';
import type { KnowledgeBase } from '@/types/api';
import type { ContextItem, KnowledgeBaseContext } from '@/types/context';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';

interface ContextSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedContexts: ContextItem[];
  onSelect: (context: ContextItem) => void;
  onDeselect: (id: number | string) => void;
  children: React.ReactNode;
}

interface KnowledgeBaseItemProps {
  kb: KnowledgeBase;
  isSelected: boolean;
  onSelect: () => void;
  t: (key: string) => string;
}

/**
 * Knowledge base item component for the selector list
 */
function KnowledgeBaseItem({ kb, isSelected, onSelect, t }: KnowledgeBaseItemProps) {
  return (
    <CommandItem
      key={kb.id}
      value={`${kb.name} ${kb.description || ''} ${kb.id}`}
      onSelect={onSelect}
      className={cn(
        'group cursor-pointer select-none',
        'px-3 py-2 text-sm text-text-primary',
        'rounded-md mx-1 my-[2px]',
        'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
        'aria-selected:bg-hover',
        '!flex !flex-row !items-start !justify-between !gap-2'
      )}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <FileText className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-medium text-sm text-text-primary truncate" title={kb.name}>
            {kb.name}
          </span>
          {kb.description && (
            <span className="text-xs text-text-muted truncate" title={kb.description}>
              {kb.description}
            </span>
          )}
          <span className="text-xs text-text-muted mt-0.5">
            {kb.document_count || 0} {t('documents')}
          </span>
        </div>
      </div>
      <Check
        className={cn(
          'h-3.5 w-3.5 shrink-0 mt-0.5',
          isSelected ? 'opacity-100 text-primary' : 'opacity-0'
        )}
      />
    </CommandItem>
  );
}

/**
 * Generic context selector component
 * Currently supports: knowledge_base
 * Future: person, bot, team
 */
export default function ContextSelector({
  open,
  onOpenChange,
  selectedContexts,
  onSelect,
  onDeselect,
  children,
}: ContextSelectorProps) {
  const { t } = useTranslation('knowledge');
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState('');

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await knowledgeBaseApi.list({ scope: 'all' });
      setKnowledgeBases(response.items);
    } catch (error) {
      console.error('Failed to fetch knowledge bases:', error);
      setError(t('fetch_error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Fetch knowledge bases on mount (not on every open) - like ModelSelector
  useEffect(() => {
    fetchKnowledgeBases();
  }, [fetchKnowledgeBases]);
  // Sort knowledge bases by name
  const sortedKnowledgeBases = useMemo(() => {
    return [...knowledgeBases].sort((a, b) => a.name.localeCompare(b.name));
  }, [knowledgeBases]);

  // Check if a context item is selected
  const isSelected = (id: number) => {
    return selectedContexts.some(ctx => ctx.id === id);
  };

  // Handle knowledge base selection
  // Handle knowledge base selection
  const handleSelect = (kb: KnowledgeBase) => {
    if (isSelected(kb.id)) {
      onDeselect(kb.id);
    } else {
      // Convert KnowledgeBase to KnowledgeBaseContext
      const context: KnowledgeBaseContext = {
        id: kb.id,
        name: kb.name,
        type: 'knowledge_base',
        description: kb.description ?? undefined,
        retriever_name: kb.retrieval_config?.retriever_name,
        retriever_namespace: kb.retrieval_config?.retriever_namespace,
      };
      onSelect(context);
    }
  };
  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchValue('');
    }
  }, [open]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-auto min-w-[320px] max-w-[400px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'max-h-[var(--radix-popover-content-available-height,400px)]',
          'flex flex-col'
        )}
        align="start"
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions={true}
        sticky="partial"
      >
        <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
          <CommandInput
            placeholder={t('search_placeholder')}
            value={searchValue}
            onValueChange={setSearchValue}
            className={cn(
              'h-9 rounded-none border-b border-border flex-shrink-0',
              'placeholder:text-text-muted text-sm'
            )}
          />
          <CommandList className="min-h-[36px] max-h-[300px] overflow-y-auto flex-1">
            {loading ? (
              <div className="py-4 px-3 text-center text-sm text-text-muted">
                {t('common:actions.loading')}
              </div>
            ) : error ? (
              <div className="py-4 px-3 text-center">
                <p className="text-sm text-red-500 mb-2">{error}</p>
                <button
                  onClick={fetchKnowledgeBases}
                  className="text-xs text-primary hover:underline"
                >
                  {t('common:actions.retry')}
                </button>
              </div>
            ) : sortedKnowledgeBases.length === 0 ? (
              <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                {t('no_knowledge_bases')}
              </CommandEmpty>
            ) : (
              <>
                <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                  {t('common:branches.no_match')}
                </CommandEmpty>
                <CommandGroup>
                  {sortedKnowledgeBases.map(kb => (
                    <KnowledgeBaseItem
                      key={kb.id}
                      kb={kb}
                      isSelected={isSelected(kb.id)}
                      onSelect={() => handleSelect(kb)}
                      t={t}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
