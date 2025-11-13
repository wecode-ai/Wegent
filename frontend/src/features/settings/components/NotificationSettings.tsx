// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  isNotificationSupported,
  isNotificationEnabled,
  requestNotificationPermission,
  setNotificationEnabled,
} from '@/utils/notification';
import { message } from 'antd';

export default function NotificationSettings() {
  const { t } = useTranslation('common');
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(isNotificationSupported());
    setEnabled(isNotificationEnabled());
  }, []);

  const handleToggle = async () => {
    if (!supported) {
      message.warning(t('notifications.not_supported'));
      return;
    }

    if (!enabled) {
      const granted = await requestNotificationPermission();
      if (granted) {
        setEnabled(true);
        message.success(t('notifications.enable_success'));
      } else {
        message.error(t('notifications.permission_denied'));
      }
    } else {
      setNotificationEnabled(false);
      setEnabled(false);
      message.success(t('notifications.disable_success'));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">
          {t('settings.sections.general')}
        </h2>
        <p className="text-sm text-text-muted">{t('notifications.enable_description')}</p>
      </div>

      <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-text-primary">
            {t('notifications.enable')}
          </h3>
          <p className="text-xs text-text-muted mt-1">{t('notifications.enable_description')}</p>
        </div>
        <button
          onClick={handleToggle}
          disabled={!supported}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            enabled
              ? 'bg-blue-600 focus:ring-blue-500'
              : 'bg-gray-300 dark:bg-gray-600 focus:ring-gray-400'
          } ${!supported ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {!supported && (
        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {t('notifications.not_supported')}
          </p>
        </div>
      )}
    </div>
  );
}
