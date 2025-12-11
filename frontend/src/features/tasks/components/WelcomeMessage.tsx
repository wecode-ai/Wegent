// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useMemo } from 'react';
import { Lightbulb } from 'lucide-react';
import { userApis } from '@/apis/user';
import { useTranslation } from '@/hooks/useTranslation';
import type { WelcomeConfigResponse, ChatTipItem } from '@/types/api';

interface WelcomeMessageProps {
  className?: string;
}

export function WelcomeMessage({ className = '' }: WelcomeMessageProps) {
  const { i18n } = useTranslation('chat');
  const [welcomeConfig, setWelcomeConfig] = useState<WelcomeConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Get current language
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en';

  // Fetch welcome config
  useEffect(() => {
    const fetchWelcomeConfig = async () => {
      try {
        setIsLoading(true);
        const response = await userApis.getWelcomeConfig();
        setWelcomeConfig(response);
      } catch (error) {
        console.error('Failed to fetch welcome config:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchWelcomeConfig();
  }, []);

  // Random tip - select once when config is loaded
  const randomTip = useMemo<ChatTipItem | null>(() => {
    if (!welcomeConfig?.tips || welcomeConfig.tips.length === 0) {
      return null;
    }
    const randomIndex = Math.floor(Math.random() * welcomeConfig.tips.length);
    return welcomeConfig.tips[randomIndex];
  }, [welcomeConfig?.tips]);

  // Get localized content
  const slogan = welcomeConfig?.slogan?.[currentLang] || welcomeConfig?.slogan?.en || '';
  const tipText = randomTip?.[currentLang] || randomTip?.en || '';

  // Don't render anything while loading or if no config
  if (isLoading || !welcomeConfig) {
    return null;
  }

  return (
    <div className={`flex flex-col items-center text-center mb-6 ${className}`}>
      {/* Slogan */}
      {slogan && (
        <h1 className="text-xl font-semibold text-text-primary mb-4">
          {slogan}
        </h1>
      )}

      {/* Random Tip */}
      {tipText && (
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface border border-border">
          <Lightbulb className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="text-sm text-text-secondary">{tipText}</span>
        </div>
      )}
    </div>
  );
}

export default WelcomeMessage;
