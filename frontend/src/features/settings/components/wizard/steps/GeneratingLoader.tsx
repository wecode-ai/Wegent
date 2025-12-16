// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Sparkles } from 'lucide-react';

interface GeneratingLoaderProps {
  className?: string;
}

export default function GeneratingLoader({ className }: GeneratingLoaderProps) {
  const { t } = useTranslation('common');
  const [tipIndex, setTipIndex] = useState(0);
  const [dots, setDots] = useState('');

  // Tips to cycle through
  const tips = [
    t('wizard.loading_tip_analyzing'),
    t('wizard.loading_tip_generating'),
    t('wizard.loading_tip_optimizing'),
    t('wizard.loading_tip_almost_done'),
  ];

  // Cycle through tips every 5 seconds, stop at the last one (no loop)
  useEffect(() => {
    const tipInterval = setInterval(() => {
      setTipIndex(prev => {
        // Stop at the last tip, don't loop
        if (prev >= tips.length - 1) {
          return prev;
        }
        return prev + 1;
      });
    }, 5000);

    return () => clearInterval(tipInterval);
  }, [tips.length]);

  // Animate dots
  useEffect(() => {
    const dotsInterval = setInterval(() => {
      setDots(prev => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);

    return () => clearInterval(dotsInterval);
  }, []);

  return (
    <div className={`flex flex-col items-center justify-center py-12 ${className || ''}`}>
      {/* Animated icon container */}
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full bg-primary/10 flex items-center justify-center">
          <Sparkles className="w-8 h-8 text-primary animate-pulse" />
        </div>
        <div className="absolute inset-0 w-16 h-16 animate-spin rounded-full border-2 border-transparent border-t-primary/40" />
      </div>

      {/* Main text */}
      <p className="mt-6 text-base font-medium text-text-primary">
        {t('wizard.generating_prompt')}
      </p>

      {/* Dynamic tip with animated dots */}
      <p className="mt-2 text-sm text-text-muted h-5 transition-opacity duration-300">
        {tips[tipIndex]}
        {dots}
      </p>

      {/* Progress hint */}
      <p className="mt-4 text-xs text-text-muted/70">{t('wizard.loading_patience_hint')}</p>
    </div>
  );
}
