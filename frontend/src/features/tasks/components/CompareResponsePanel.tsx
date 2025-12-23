// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useMemo, useCallback } from 'react';
import { Check, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCompareContext, ModelResponseState } from '../contexts/compareContext';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import MarkdownRenderer from './MarkdownRenderer';

interface ResponseCardProps {
  modelState: ModelResponseState;
  onSelect: () => void;
  allDone: boolean;
  isLast: boolean;
}

function ResponseCard({ modelState, onSelect, allDone, isLast }: ResponseCardProps) {
  const { t } = useTranslation();
  const { modelDisplayName, content, status, error, isSelected } = modelState;

  const statusBadge = useMemo(() => {
    switch (status) {
      case 'pending':
        return (
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('chat.compare.pending')}
          </Badge>
        );
      case 'streaming':
        return (
          <Badge variant="info" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('chat.compare.streaming')}
          </Badge>
        );
      case 'completed':
        return <Badge variant="success">{t('chat.compare.completed')}</Badge>;
      case 'error':
        return (
          <Badge variant="error" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            {t('chat.compare.error')}
          </Badge>
        );
      default:
        return null;
    }
  }, [status, t]);

  return (
    <Card
      className={cn(
        'flex flex-col h-full overflow-hidden transition-all',
        isSelected && 'ring-2 ring-primary',
        !isLast && 'border-r-0'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-bg-surface">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate max-w-[150px]">{modelDisplayName}</span>
          {statusBadge}
        </div>
        {isSelected && <Check className="h-4 w-4 text-primary" />}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 p-3">
        {error ? (
          <div className="text-error text-sm">
            <AlertCircle className="h-4 w-4 inline mr-1" />
            {error}
          </div>
        ) : content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={content} />
          </div>
        ) : (
          <div className="text-text-muted text-sm italic">{t('chat.compare.waitingResponse')}</div>
        )}
      </ScrollArea>

      {/* Footer - Select Button */}
      {allDone && status === 'completed' && !isSelected && (
        <div className="p-3 border-t border-border bg-bg-surface">
          <Button variant="outline" size="sm" onClick={onSelect} className="w-full">
            <Check className="h-4 w-4 mr-1" />
            {t('chat.compare.selectThis')}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function CompareResponsePanel() {
  const { t } = useTranslation();
  const { activeCompareGroup, selectResponse } = useCompareContext();

  // Extract values with defaults to ensure hooks are called unconditionally
  const compareGroupId = activeCompareGroup?.compareGroupId ?? '';
  const responses = activeCompareGroup?.responses;
  const allDone = activeCompareGroup?.allDone ?? false;
  const responseList = responses ? Array.from(responses.values()) : [];
  const modelCount = responseList.length;

  // Calculate grid layout based on number of models
  const gridCols = useMemo(() => {
    switch (modelCount) {
      case 2:
        return 'grid-cols-2';
      case 3:
        return 'grid-cols-3';
      case 4:
        return 'grid-cols-2 lg:grid-cols-4';
      default:
        return 'grid-cols-2';
    }
  }, [modelCount]);

  const handleSelect = useCallback(
    (modelName: string) => {
      selectResponse(compareGroupId, modelName);
    },
    [selectResponse, compareGroupId]
  );

  if (!activeCompareGroup) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">
          {t('chat.compare.comparing')} ({modelCount} {t('chat.compare.models')})
        </h3>
        {allDone && <Badge variant="success">{t('chat.compare.allCompleted')}</Badge>}
      </div>

      {/* Hint */}
      {allDone && <p className="text-sm text-text-secondary">{t('chat.compare.selectHint2')}</p>}

      {/* Response Grid */}
      <div className={cn('grid gap-4 min-h-[400px]', gridCols)}>
        {responseList.map((modelState, index) => (
          <ResponseCard
            key={modelState.modelName}
            modelState={modelState}
            onSelect={() => handleSelect(modelState.modelName)}
            allDone={allDone}
            isLast={index === responseList.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

// Collapsed view for historical comparisons
interface CollapsedCompareViewProps {
  compareGroupId: string;
  className?: string;
}

export function CollapsedCompareView({ compareGroupId, className }: CollapsedCompareViewProps) {
  const { t } = useTranslation();
  const { compareHistory } = useCompareContext();

  const group = compareHistory.get(compareGroupId);
  if (!group) return null;

  const { responses, selectedModelName } = group;
  const selectedResponse = selectedModelName ? responses.get(selectedModelName) : null;

  const otherResponses = Array.from(responses.values()).filter(
    r => r.modelName !== selectedModelName
  );

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Selected Response */}
      {selectedResponse && (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="success" className="gap-1">
              <Check className="h-3 w-3" />
              {selectedResponse.modelDisplayName}
            </Badge>
            <span className="text-xs text-text-muted">{t('chat.compare.selectedResponse')}</span>
          </div>
          <MarkdownRenderer content={selectedResponse.content} />
        </div>
      )}

      {/* Other Responses (collapsed) */}
      {otherResponses.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm text-text-secondary cursor-pointer hover:text-text-primary">
            {t('chat.compare.viewOtherResponses')} ({otherResponses.length})
          </summary>
          <div className="mt-2 space-y-4 pl-4 border-l-2 border-border">
            {otherResponses.map(response => (
              <div key={response.modelName} className="opacity-70">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="secondary">{response.modelDisplayName}</Badge>
                </div>
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer content={response.content} />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default CompareResponsePanel;
