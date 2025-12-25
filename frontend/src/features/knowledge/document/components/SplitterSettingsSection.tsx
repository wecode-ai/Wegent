// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useTranslation } from '@/hooks/useTranslation';
import type { SplitterConfig } from '@/types/knowledge';

// Re-export SplitterConfig for backward compatibility
export type { SplitterConfig };

interface SplitterSettingsSectionProps {
  config: Partial<SplitterConfig>;
  onChange: (config: Partial<SplitterConfig>) => void;
  readOnly?: boolean;
}

export function SplitterSettingsSection({
  config,
  onChange,
  readOnly = false,
}: SplitterSettingsSectionProps) {
  const { t } = useTranslation();
  const [overlapError, setOverlapError] = useState('');

  const chunkSize = config.chunk_size ?? 1024;
  const chunkOverlap = config.chunk_overlap ?? 50;

  useEffect(() => {
    if (chunkOverlap >= chunkSize) {
      setOverlapError(t('knowledge.document.splitter.overlapError'));
    } else {
      setOverlapError('');
    }
  }, [chunkSize, chunkOverlap, t]);

  const handleChunkSizeChange = (value: number) => {
    const newValue = Math.max(128, Math.min(8192, value));
    onChange({ ...config, chunk_size: newValue });
  };

  const handleChunkOverlapChange = (value: number) => {
    const newValue = Math.max(0, Math.min(chunkSize - 1, value));
    onChange({ ...config, chunk_overlap: newValue });
  };

  return (
    <div className="space-y-4">
      {/* Chunking Type */}
      <div className="space-y-2">
        <Label htmlFor="splitter-type">{t('knowledge.document.splitter.type')}</Label>
        <SearchableSelect
          value={config.type || 'sentence'}
          onValueChange={value => onChange({ ...config, type: value as 'sentence' })}
          disabled={readOnly}
          items={[{ value: 'sentence', label: t('knowledge.document.splitter.general') }]}
        />
      </div>

      {/* Separator */}
      <div className="space-y-2">
        <Label htmlFor="separator">{t('knowledge.document.splitter.separator')}</Label>
        <Input
          id="separator"
          type="text"
          value={config.separator ?? '\n\n'}
          onChange={e => onChange({ ...config, separator: e.target.value })}
          disabled={readOnly}
          placeholder="\n\n"
        />
        <p className="text-xs text-text-muted">{t('knowledge.document.splitter.separatorHint')}</p>
      </div>

      {/* Chunk Size */}
      <div className="space-y-2">
        <Label htmlFor="chunk-size">{t('knowledge.document.splitter.chunkSize')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="chunk-size"
            type="number"
            min={128}
            max={8192}
            value={chunkSize}
            onChange={e => handleChunkSizeChange(parseInt(e.target.value) || 128)}
            disabled={readOnly}
            className="flex-1"
          />
          <span className="text-sm text-text-secondary whitespace-nowrap">
            {t('knowledge.document.splitter.characters')}
          </span>
        </div>
        <p className="text-xs text-text-muted">{t('knowledge.document.splitter.chunkSizeHint')}</p>
      </div>

      {/* Chunk Overlap */}
      <div className="space-y-2">
        <Label htmlFor="chunk-overlap">{t('knowledge.document.splitter.chunkOverlap')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="chunk-overlap"
            type="number"
            min={0}
            max={chunkSize - 1}
            value={chunkOverlap}
            onChange={e => handleChunkOverlapChange(parseInt(e.target.value) || 0)}
            disabled={readOnly}
            className="flex-1"
          />
          <span className="text-sm text-text-secondary whitespace-nowrap">
            {t('knowledge.document.splitter.characters')}
          </span>
        </div>
        <p className="text-xs text-text-muted">
          {t('knowledge.document.splitter.chunkOverlapHint')}
        </p>
        {overlapError && <p className="text-sm text-error">{overlapError}</p>}
      </div>
    </div>
  );
}
