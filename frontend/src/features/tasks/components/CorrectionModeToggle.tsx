// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect } from 'react';
import { CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { modelApis, UnifiedModel } from '@/apis/models';
import { correctionApis, CorrectionModeState } from '@/apis/correction';

interface CorrectionModeToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean, modelId?: string, modelName?: string) => void;
  disabled?: boolean;
  correctionModelName?: string | null;
}

export default function CorrectionModeToggle({
  enabled,
  onToggle,
  disabled = false,
  correctionModelName,
}: CorrectionModeToggleProps) {
  const { t } = useTranslation('chat');
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Load models when dialog opens
  useEffect(() => {
    if (showModelSelector) {
      loadModels();
    }
  }, [showModelSelector]);

  // Restore state from localStorage on mount
  useEffect(() => {
    const savedState = correctionApis.getCorrectionModeState();
    if (savedState.enabled && savedState.correctionModelId) {
      onToggle(true, savedState.correctionModelId, savedState.correctionModelName || undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadModels = async () => {
    setIsLoading(true);
    try {
      // Get all unified models (both public and user-defined) for LLM type
      const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm');
      setModels(response.data || []);
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = () => {
    if (!enabled) {
      // Opening: show model selector
      setShowModelSelector(true);
    } else {
      // Closing: disable correction mode
      onToggle(false);
      correctionApis.clearCorrectionModeState();
    }
  };

  const handleModelSelect = (model: UnifiedModel) => {
    const displayName = model.displayName || model.name;
    onToggle(true, model.name, displayName);

    // Save to localStorage with web search enabled by default
    const state: CorrectionModeState = {
      enabled: true,
      correctionModelId: model.name,
      correctionModelName: displayName,
      enableWebSearch: true, // Enable web search by default for fact verification
    };
    correctionApis.saveCorrectionModeState(state);

    setShowModelSelector(false);
    setSearchQuery('');
  };

  const handleDialogClose = () => {
    setShowModelSelector(false);
    setSearchQuery('');
  };

  // Filter models by search query
  const filteredModels = models.filter(model => {
    const searchLower = searchQuery.toLowerCase();
    const nameMatch = model.name.toLowerCase().includes(searchLower);
    const displayNameMatch = model.displayName?.toLowerCase().includes(searchLower);
    return nameMatch || displayNameMatch;
  });

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={handleToggle}
              disabled={disabled}
              className={cn(
                'h-8 w-8 rounded-full flex-shrink-0 transition-colors',
                enabled
                  ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-base text-text-primary hover:bg-hover'
              )}
            >
              <CheckCircle className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {enabled
                ? `${t('correction.disable')}${correctionModelName ? ` (${correctionModelName})` : ''}`
                : t('correction.enable')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Model Selection Dialog */}
      <Dialog open={showModelSelector} onOpenChange={handleDialogClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('correction.select_model')}</DialogTitle>
            <DialogDescription>{t('correction.select_model_desc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Search Input */}
            <Input
              placeholder={t('correction.search_model')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full"
            />

            {/* Model List */}
            <ScrollArea className="h-[300px] pr-4">
              {isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                </div>
              ) : filteredModels.length === 0 ? (
                <div className="flex items-center justify-center h-full text-text-muted">
                  {t('correction.no_models')}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredModels.map(model => (
                    <Button
                      key={`${model.type}-${model.name}`}
                      variant="ghost"
                      className="w-full justify-start text-left h-auto py-3 px-4 hover:bg-hover"
                      onClick={() => handleModelSelect(model)}
                    >
                      <div className="flex flex-col items-start gap-1">
                        <span className="font-medium">{model.displayName || model.name}</span>
                        {model.displayName && model.displayName !== model.name && (
                          <span className="text-xs text-text-muted">{model.name}</span>
                        )}
                        <span className="text-xs text-text-muted capitalize">
                          {model.type === 'public'
                            ? t('correction.public_model')
                            : t('correction.user_model')}
                        </span>
                      </div>
                    </Button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
