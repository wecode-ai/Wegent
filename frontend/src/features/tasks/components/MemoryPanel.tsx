// SPDX-FileCopyrightText: 2025 WeCode-AI, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Brain, Search, Trash2, X, Check, Pencil, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import {
  Memory,
  getMemories,
  updateMemory,
  deleteMemory,
  checkMemoryHealth,
} from '@/apis/memory';

interface MemoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Memory Panel component for managing user long-term memories.
 *
 * Features:
 * - Display list of user memories
 * - Search/filter memories by keyword
 * - Edit memory content inline
 * - Delete individual memories
 */
export default function MemoryPanel({ isOpen, onClose }: MemoryPanelProps) {
  const { toast } = useToast();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  // Check if memory service is configured
  useEffect(() => {
    if (isOpen) {
      checkMemoryHealth()
        .then((status) => {
          setIsConfigured(status.configured && status.healthy);
        })
        .catch(() => {
          setIsConfigured(false);
        });
    }
  }, [isOpen]);

  // Load memories when panel opens
  const loadMemories = useCallback(async () => {
    if (!isConfigured) return;

    setIsLoading(true);
    try {
      const response = await getMemories(searchKeyword || undefined);
      setMemories(response.memories);
    } catch (error) {
      console.error('Failed to load memories:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load memories',
      });
    } finally {
      setIsLoading(false);
    }
  }, [isConfigured, searchKeyword, toast]);

  useEffect(() => {
    if (isOpen && isConfigured) {
      loadMemories();
    }
  }, [isOpen, isConfigured, loadMemories]);

  // Handle search
  const handleSearch = useCallback(() => {
    loadMemories();
  }, [loadMemories]);

  // Handle edit start
  const handleEditStart = useCallback((memory: Memory) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    // Focus the input after state update
    setTimeout(() => {
      editInputRef.current?.focus();
    }, 0);
  }, []);

  // Handle edit save
  const handleEditSave = useCallback(
    async (memoryId: string) => {
      if (!editContent.trim()) {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Memory content cannot be empty',
        });
        return;
      }

      try {
        await updateMemory(memoryId, editContent.trim());
        setMemories((prev) =>
          prev.map((m) => (m.id === memoryId ? { ...m, content: editContent.trim() } : m))
        );
        setEditingId(null);
        setEditContent('');
        toast({
          title: 'Success',
          description: 'Memory updated successfully',
        });
      } catch (error) {
        console.error('Failed to update memory:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to update memory',
        });
      }
    },
    [editContent, toast]
  );

  // Handle edit cancel
  const handleEditCancel = useCallback(() => {
    setEditingId(null);
    setEditContent('');
  }, []);

  // Handle delete
  const handleDelete = useCallback(
    async (memoryId: string) => {
      if (!confirm('Are you sure you want to delete this memory?')) {
        return;
      }

      try {
        await deleteMemory(memoryId);
        setMemories((prev) => prev.filter((m) => m.id !== memoryId));
        toast({
          title: 'Success',
          description: 'Memory deleted successfully',
        });
      } catch (error) {
        console.error('Failed to delete memory:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to delete memory',
        });
      }
    },
    [toast]
  );

  // Format date for display
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-surface border-l border-border shadow-lg z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-base font-semibold text-text-primary">Memories</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Service not configured message */}
      {!isConfigured && (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-text-muted">
            <Brain className="w-12 h-12 mx-auto mb-2 opacity-30" />
            <p className="text-sm">Memory service is not configured</p>
            <p className="text-xs mt-1">Configure MEM0_BASE_URL to enable</p>
          </div>
        </div>
      )}

      {/* Content when configured */}
      {isConfigured && (
        <>
          {/* Search bar */}
          <div className="p-3 border-b border-border">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                <Input
                  placeholder="Search memories..."
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className="pl-8 h-9 text-sm"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={loadMemories}
                disabled={isLoading}
                className="h-9 w-9"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {/* Memory list */}
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-3">
              {isLoading && memories.length === 0 ? (
                <div className="text-center text-text-muted py-8">
                  <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin" />
                  <p className="text-sm">Loading memories...</p>
                </div>
              ) : memories.length === 0 ? (
                <div className="text-center text-text-muted py-8">
                  <Brain className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No memories yet</p>
                  <p className="text-xs mt-1">Chat with the assistant to create memories</p>
                </div>
              ) : (
                memories.map((memory) => (
                  <Card key={memory.id} className="p-3 bg-bg-muted">
                    {editingId === memory.id ? (
                      // Edit mode
                      <div className="space-y-2">
                        <textarea
                          ref={editInputRef}
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          className="w-full min-h-[80px] p-2 text-sm bg-base border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleEditSave(memory.id);
                            }
                            if (e.key === 'Escape') {
                              handleEditCancel();
                            }
                          }}
                        />
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleEditCancel}
                            className="h-7 w-7"
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditSave(memory.id)}
                            className="h-7 w-7 text-primary"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      // View mode
                      <>
                        <p className="text-sm text-text-primary whitespace-pre-wrap break-words">
                          {memory.content}
                        </p>
                        <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                          <span className="text-xs text-text-muted">
                            {formatDate(memory.updated_at || memory.created_at)}
                          </span>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEditStart(memory)}
                              className="h-6 w-6"
                            >
                              <Pencil className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(memory.id)}
                              className="h-6 w-6 text-error hover:text-error"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </Card>
                ))
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}
