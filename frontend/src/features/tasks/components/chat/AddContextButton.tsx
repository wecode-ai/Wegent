// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/hooks/useTranslation';

interface AddContextButtonProps {
  onClick: () => void;
}

/**
 * Add Context Button - Icon-only button that opens knowledge base selector
 * Always displays "@" symbol with tooltip on hover
 * Matches AttachmentButton's visual style (h-9 w-9 rounded-full)
 */
export default function AddContextButton({ onClick }: AddContextButtonProps) {
  const { t } = useTranslation('knowledge');

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onClick}
            className="h-9 w-9 rounded-full border-border bg-base text-text-primary hover:bg-hover"
            aria-label={t('tooltip')}
          >
            <span className="text-base font-medium text-text-primary">@</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{t('tooltip')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
