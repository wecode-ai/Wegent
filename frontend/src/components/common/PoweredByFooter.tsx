// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useTranslation } from '@/hooks/useTranslation';

interface PoweredByFooterProps {
  className?: string;
}

/**
 * Footer component that displays "Powered by AI应用平台" branding
 * Used on home page and task pages (when no task is selected)
 */
export default function PoweredByFooter({ className = '' }: PoweredByFooterProps) {
  const { t } = useTranslation('common');

  return (
    <div className={`fixed bottom-2 right-3 pointer-events-none ${className}`}>
      <a
        href="https://aigc.intra.weibo.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-text-muted hover:text-text-secondary transition-colors pointer-events-auto"
      >
        {t('footer.powered_by')}
      </a>
    </div>
  );
}
