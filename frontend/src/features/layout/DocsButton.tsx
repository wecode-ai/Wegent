// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { paths } from '@/config/paths';
import { useTranslation } from '@/hooks/useTranslation';

export function DocsButton({
  className = '',
  onClick,
  showLabel = false,
}: {
  className?: string;
  onClick?: () => void;
  showLabel?: boolean;
}) {
  const { t } = useTranslation('common');

  const navigateToDocs = () => {
    // Use window.open to open documentation in new tab
    window.open(paths.docs.getHref(), '_blank');
    onClick?.();
  };

  if (showLabel) {
    return (
      <Button
        type="button"
        onClick={navigateToDocs}
        variant="ghost"
        size="sm"
        className={`justify-start gap-3 text-sm ${className}`}
        aria-label={t('navigation.docs')}
      >
        <FileText className="h-4 w-4 text-text-muted" />
        <span>{t('navigation.docs')}</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      onClick={navigateToDocs}
      variant="ghost"
      size="sm"
      shape="pill"
      className={`bg-muted border border-border font-medium hover:bg-border/40 gap-1 ${className}`}
      aria-label={t('navigation.docs')}
    >
      <FileText className="h-4 w-4 text-text-muted" />
    </Button>
  );
}
