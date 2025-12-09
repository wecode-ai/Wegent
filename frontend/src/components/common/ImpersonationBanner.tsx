// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState } from 'react';
import { useUser } from '@/features/common/UserContext';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/ui/button';
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';

/**
 * Impersonation Banner Component
 *
 * Displays a warning banner at the top of the page when an admin is
 * impersonating another user. Shows the impersonated user's name,
 * remaining session time, and an exit button.
 */
const ImpersonationBanner: React.FC = () => {
  const { t } = useTranslation('admin');
  const { user, isImpersonating, impersonatorName, impersonationExpiresAt, exitImpersonation } =
    useUser();
  const [remainingTime, setRemainingTime] = useState<string>('');
  const [isExiting, setIsExiting] = useState(false);

  // Update remaining time countdown
  useEffect(() => {
    if (!isImpersonating || !impersonationExpiresAt) {
      return;
    }

    const updateRemainingTime = () => {
      const now = new Date();
      const expiresAt = new Date(impersonationExpiresAt);
      const diff = expiresAt.getTime() - now.getTime();

      if (diff <= 0) {
        setRemainingTime('00:00:00');
        // Session expired, trigger exit
        exitImpersonation();
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setRemainingTime(
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      );
    };

    updateRemainingTime();
    const interval = setInterval(updateRemainingTime, 1000);

    return () => clearInterval(interval);
  }, [isImpersonating, impersonationExpiresAt, exitImpersonation]);

  // Don't render if not impersonating
  if (!isImpersonating || !user) {
    return null;
  }

  const handleExit = async () => {
    setIsExiting(true);
    try {
      await exitImpersonation();
    } finally {
      setIsExiting(false);
    }
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-amber-950 px-4 py-2 shadow-md">
      <div className="container mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ExclamationTriangleIcon className="w-5 h-5" />
          <span className="font-medium">
            {t('impersonation.banner.viewing_as', { name: user.user_name })}
          </span>
          <span className="text-amber-800">|</span>
          <span className="text-sm">
            {t('impersonation.banner.remaining_time')}: {remainingTime}
          </span>
          {impersonatorName && (
            <>
              <span className="text-amber-800">|</span>
              <span className="text-sm text-amber-800">
                {t('impersonation.banner.admin')}: {impersonatorName}
              </span>
            </>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExit}
          disabled={isExiting}
          className="bg-white/90 hover:bg-white text-amber-950 border-amber-700 hover:border-amber-800"
        >
          <XMarkIcon className="w-4 h-4 mr-1" />
          {isExiting ? t('impersonation.banner.exiting') : t('impersonation.banner.exit')}
        </Button>
      </div>
    </div>
  );
};

export default ImpersonationBanner;
