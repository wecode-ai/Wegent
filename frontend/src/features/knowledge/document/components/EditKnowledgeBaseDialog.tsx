// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { KnowledgeBase, KnowledgeBaseUpdate, RetrievalConfigUpdate } from '@/types/knowledge';
import { RetrievalSettingsSection, RetrievalConfig } from './RetrievalSettingsSection';

interface EditKnowledgeBaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledgeBase: KnowledgeBase | null;
  onSubmit: (data: KnowledgeBaseUpdate) => Promise<void>;
  loading?: boolean;
}

export function EditKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSubmit,
  loading,
}: EditKnowledgeBaseDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [retrievalConfig, setRetrievalConfig] = useState<Partial<RetrievalConfig>>({});

  useEffect(() => {
    if (knowledgeBase) {
      setName(knowledgeBase.name);
      setDescription(knowledgeBase.description || '');
      setShowAdvanced(false); // Reset expanded state
      // Initialize retrieval config from knowledge base
      if (knowledgeBase.retrieval_config) {
        setRetrievalConfig(knowledgeBase.retrieval_config);
      }
    }
  }, [knowledgeBase]);

  const handleRetrievalConfigChange = useCallback((config: Partial<RetrievalConfig>) => {
    setRetrievalConfig(config);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError(t('knowledge.document.knowledgeBase.nameRequired'));
      return;
    }

    if (name.length > 100) {
      setError(t('knowledge.document.knowledgeBase.nameTooLong'));
      return;
    }

    try {
      // Build update data
      const updateData: KnowledgeBaseUpdate = {
        name: name.trim(),
        description: description.trim() || undefined,
      };

      // Add retrieval config update if advanced settings were modified
      if (knowledgeBase?.retrieval_config && retrievalConfig) {
        const retrievalConfigUpdate: RetrievalConfigUpdate = {};

        // Only include fields that can be updated (exclude retriever and embedding_config)
        if (retrievalConfig.retrieval_mode !== undefined) {
          retrievalConfigUpdate.retrieval_mode = retrievalConfig.retrieval_mode;
        }
        if (retrievalConfig.top_k !== undefined) {
          retrievalConfigUpdate.top_k = retrievalConfig.top_k;
        }
        if (retrievalConfig.score_threshold !== undefined) {
          retrievalConfigUpdate.score_threshold = retrievalConfig.score_threshold;
        }
        if (retrievalConfig.hybrid_weights !== undefined) {
          retrievalConfigUpdate.hybrid_weights = retrievalConfig.hybrid_weights;
        }

        // Only add retrieval_config if there are changes
        if (Object.keys(retrievalConfigUpdate).length > 0) {
          updateData.retrieval_config = retrievalConfigUpdate;
        }
      }

      await onSubmit(updateData);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setError('');
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('knowledge.document.knowledgeBase.edit')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('knowledge.document.knowledgeBase.name')}</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('knowledge.document.knowledgeBase.namePlaceholder')}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">
                {t('knowledge.document.knowledgeBase.description')}
              </Label>
              <Textarea
                id="edit-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('knowledge.document.knowledgeBase.descriptionPlaceholder')}
                maxLength={500}
                rows={3}
              />
            </div>

            {/* Advanced Settings (Partially Editable) */}
            {knowledgeBase?.retrieval_config && (
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors"
                >
                  {showAdvanced ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  {t('knowledge.document.advancedSettings.title')}
                </button>

                {showAdvanced && (
                  <div className="mt-4 p-4 bg-bg-muted rounded-lg border border-border">
                    <RetrievalSettingsSection
                      config={retrievalConfig}
                      onChange={handleRetrievalConfigChange}
                      readOnly={false}
                      partialReadOnly={true}
                    />
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-sm text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? t('actions.saving') : t('actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
