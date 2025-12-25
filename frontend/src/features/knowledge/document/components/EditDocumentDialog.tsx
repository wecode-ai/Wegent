// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { updateDocument } from '@/apis/knowledge';
import type { KnowledgeDocument, SplitterConfig } from '@/types/knowledge';
import { SplitterSettingsSection } from './SplitterSettingsSection';

interface EditDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: KnowledgeDocument | null;
  onSuccess: () => void;
}

export function EditDocumentDialog({
  open,
  onOpenChange,
  document,
  onSuccess,
}: EditDocumentDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [splitterConfig, setSplitterConfig] = useState<Partial<SplitterConfig>>({
    type: 'sentence',
    separator: '\n\n',
    chunk_size: 1024,
    chunk_overlap: 50,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reset form when document changes
  useEffect(() => {
    if (document) {
      setName(document.name);
      // Load existing splitter_config or use defaults
      if (document.splitter_config) {
        setSplitterConfig({
          type: document.splitter_config.type || 'sentence',
          separator: document.splitter_config.separator ?? '\n\n',
          chunk_size: document.splitter_config.chunk_size ?? 1024,
          chunk_overlap: document.splitter_config.chunk_overlap ?? 50,
        });
      } else {
        setSplitterConfig({
          type: 'sentence',
          separator: '\n\n',
          chunk_size: 1024,
          chunk_overlap: 50,
        });
      }
      setError('');
      setShowAdvanced(false); // Reset to collapsed state
    }
  }, [document]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!document) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('knowledge.document.document.nameRequired'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Only update name, splitter_config is read-only
      await updateDocument(document.id, {
        name: trimmedName,
      });
      onSuccess();
    } catch (err) {
      setError(t('knowledge.document.document.updateFailed'));
      console.error('Failed to update document:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('knowledge.document.document.edit')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4 space-y-6">
            {/* Document Name */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {t('knowledge.document.document.columns.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('knowledge.document.document.namePlaceholder')}
                autoFocus
              />
            </div>

            {/* Advanced Settings - Splitter Configuration (Collapsible, Read-only) */}
            <div className="border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors w-full"
              >
                {showAdvanced ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                {t('knowledge.document.splitter.title')}
                <span className="text-xs text-text-muted font-normal ml-auto">
                  {t('knowledge.document.advancedSettings.readOnly')}
                </span>
              </button>

              {showAdvanced && (
                <div className="mt-4">
                  <SplitterSettingsSection
                    config={splitterConfig}
                    onChange={() => {}} // No-op since it's read-only
                    readOnly={true}
                  />
                </div>
              )}
            </div>

            {error && <p className="text-xs text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !name.trim()}>
              {loading ? t('actions.saving') : t('actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
