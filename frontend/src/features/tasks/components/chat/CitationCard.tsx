// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { FileText } from 'lucide-react';
import { Card } from '@/components/ui/card';

export interface Citation {
  document_id: number;
  knowledge_base_id: number;
  knowledge_base_name: string;
  document_name: string;
  snippet: string;
  score: number;
}

interface CitationCardProps {
  citations: Citation[];
}

export default function CitationCard({ citations }: CitationCardProps) {
  if (!citations || citations.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 mb-4">
      <div className="text-xs text-text-muted font-medium">
        Referenced from {citations.length} source{citations.length > 1 ? 's' : ''}:
      </div>
      <div className="space-y-1">
        {citations.slice(0, 3).map((citation, index) => (
          <Card
            key={`citation-${citation.document_id}-${index}`}
            variant="ghost"
            padding="sm"
            className="hover:bg-muted/50 transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-2">
              <FileText className="w-4 h-4 text-text-secondary mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary font-medium truncate">
                  {citation.document_name}
                </div>
                <div className="text-xs text-text-muted truncate">
                  {citation.knowledge_base_name}
                </div>
                <div className="text-xs text-text-secondary mt-1 line-clamp-2">
                  {citation.snippet}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  Relevance: {Math.round(citation.score * 100)}%
                </div>
              </div>
            </div>
          </Card>
        ))}
        {citations.length > 3 && (
          <div className="text-xs text-text-muted text-center py-1">
            +{citations.length - 3} more source{citations.length - 3 > 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
