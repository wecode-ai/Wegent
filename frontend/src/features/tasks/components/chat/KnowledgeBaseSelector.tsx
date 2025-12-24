// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { knowledgeBaseApi } from '@/apis/knowledge-base';
import type { KnowledgeBase } from '@/types/api';

interface KnowledgeBaseSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedKnowledgeBases: KnowledgeBase[];
  onSelect: (knowledgeBase: KnowledgeBase) => void;
  onDeselect: (id: number) => void;
  children: React.ReactNode;
}

export default function KnowledgeBaseSelector({
  open,
  onOpenChange,
  selectedKnowledgeBases,
  onSelect,
  onDeselect,
  children,
}: KnowledgeBaseSelectorProps) {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch knowledge bases when popover opens
  useEffect(() => {
    if (open) {
      fetchKnowledgeBases();
    }
  }, [open]);

  const fetchKnowledgeBases = async () => {
    setLoading(true);
    try {
      const response = await knowledgeBaseApi.list({ scope: 'all' });
      setKnowledgeBases(response.items);
    } catch (error) {
      console.error('Failed to fetch knowledge bases:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter knowledge bases based on search query
  const filteredKnowledgeBases = knowledgeBases.filter(
    kb =>
      kb.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (kb.description && kb.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Check if a knowledge base is selected
  const isSelected = (id: number) => {
    return selectedKnowledgeBases.some(kb => kb.id === id);
  };

  // Handle knowledge base click
  const handleClick = (kb: KnowledgeBase) => {
    if (isSelected(kb.id)) {
      onDeselect(kb.id);
    } else {
      onSelect(kb);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <div className="flex flex-col max-h-[400px]">
          {/* Search input */}
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
              <Input
                type="text"
                placeholder="Search knowledge bases..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>
          </div>

          {/* Knowledge base list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-text-muted">Loading...</div>
            ) : filteredKnowledgeBases.length === 0 ? (
              <div className="p-4 text-center text-text-muted">No knowledge bases found</div>
            ) : (
              <div className="p-1">
                {filteredKnowledgeBases.map(kb => (
                  <button
                    key={kb.id}
                    onClick={() => handleClick(kb)}
                    className="w-full text-left px-3 py-2 hover:bg-muted rounded-md transition-colors flex items-start gap-3"
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {isSelected(kb.id) ? (
                        <div className="w-4 h-4 bg-primary rounded-sm flex items-center justify-center">
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      ) : (
                        <div className="w-4 h-4 border border-border rounded-sm" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">
                        {kb.name}
                      </div>
                      {kb.description && (
                        <div className="text-xs text-text-muted truncate mt-0.5">
                          {kb.description}
                        </div>
                      )}
                      <div className="text-xs text-text-muted mt-1">
                        {kb.document_count || 0} documents
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-2 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="w-full"
            >
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
