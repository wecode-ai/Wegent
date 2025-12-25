// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/hooks/useTranslation';
import {
  isNotificationSupported,
  isNotificationEnabled,
  requestNotificationPermission,
  setNotificationEnabled,
} from '@/utils/notification';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { useUser } from '@/features/common/UserContext';
import { userApis } from '@/apis/user';
import type { UserPreferences } from '@/types/api';

export default function NotificationSettings() {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const router = useRouter();
  const { user, refresh } = useUser();
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(true);
  const [sendKey, setSendKey] = useState<'enter' | 'cmd_enter'>('enter');
  const [searchKey, setSearchKey] = useState<'cmd_k' | 'cmd_f' | 'disabled'>('cmd_k');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setSupported(isNotificationSupported());
    setEnabled(isNotificationEnabled());
  }, []);

  useEffect(() => {
    // Only update sendKey and searchKey when user data is loaded and has preferences
    // Use 'enter' as default if send_key is not set
    // Use 'cmd_k' as default if search_key is not set
    if (user) {
      const userSendKey = user.preferences?.send_key || 'enter';
      const userSearchKey = user.preferences?.search_key || 'cmd_k';
      setSendKey(userSendKey);
      setSearchKey(userSearchKey);
    }
  }, [user]);

  const handleToggle = async () => {
    if (!supported) {
      toast({
        title: t('notifications.not_supported'),
      });
      return;
    }

    if (!enabled) {
      const granted = await requestNotificationPermission();
      if (granted) {
        setEnabled(true);
        toast({
          title: t('notifications.enable_success'),
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('notifications.permission_denied'),
        });
      }
    } else {
      setNotificationEnabled(false);
      setEnabled(false);
      toast({
        title: t('notifications.disable_success'),
      });
    }
  };

  const handleSendKeyChange = async (value: 'enter' | 'cmd_enter') => {
    setSendKey(value);
    setIsSaving(true);
    try {
      const preferences: UserPreferences = { send_key: value };
      await userApis.updateUser({ preferences });
      await refresh();
      toast({
        title: t('send_key.save_success'),
      });
    } catch (error) {
      console.error('Failed to save send key preference:', error);
      toast({
        variant: 'destructive',
        title: t('send_key.save_failed'),
      });
      // Revert to previous value
      setSendKey(user?.preferences?.send_key || 'enter');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSearchKeyChange = async (value: 'cmd_k' | 'cmd_f' | 'disabled') => {
    setSearchKey(value);
    setIsSaving(true);
    try {
      const preferences: UserPreferences = {
        send_key: user?.preferences?.send_key || 'enter',
        search_key: value,
      };
      await userApis.updateUser({ preferences });
      await refresh();
      toast({
        title: t('search_key.save_success'),
      });
    } catch (error) {
      console.error('Failed to save search key preference:', error);
      toast({
        variant: 'destructive',
        title: t('search_key.save_failed'),
      });
      // Revert to previous value
      setSearchKey(user?.preferences?.search_key || 'cmd_k');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRestartOnboarding = () => {
    localStorage.removeItem('user_onboarding_completed');
    localStorage.removeItem('onboarding_in_progress');
    localStorage.removeItem('onboarding_current_step');
    router.push('/chat');
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">
          {t('settings.sections.general')}
        </h2>
        <p className="text-sm text-text-muted">{t('notifications.enable_description')}</p>
      </div>

      <div className="flex items-center justify-between p-4 bg-base border border-border rounded-lg">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-text-primary">{t('notifications.enable')}</h3>
          <p className="text-xs text-text-muted mt-1">{t('notifications.enable_description')}</p>
        </div>
        <Switch checked={enabled} onCheckedChange={handleToggle} disabled={!supported} />
      </div>

      {!supported && (
        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            {t('notifications.not_supported')}
          </p>
        </div>
      )}

      {/* Send Key Shortcut Setting */}
      <div className="p-4 bg-base border border-border rounded-lg">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-text-primary">{t('send_key.title')}</h3>
          <p className="text-xs text-text-muted mt-1">{t('send_key.description')}</p>
        </div>
        <RadioGroup
          value={sendKey}
          onValueChange={value => handleSendKeyChange(value as 'enter' | 'cmd_enter')}
          disabled={isSaving}
          className="space-y-2"
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="enter" id="send-key-enter" />
            <Label htmlFor="send-key-enter" className="text-sm cursor-pointer">
              {t('send_key.option_enter')}
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="cmd_enter" id="send-key-cmd-enter" />
            <Label htmlFor="send-key-cmd-enter" className="text-sm cursor-pointer">
              {t('send_key.option_cmd_enter')}
            </Label>
          </div>
        </RadioGroup>
      </div>

      {/* Search Key Shortcut Setting */}
      <div className="p-4 bg-base border border-border rounded-lg">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-text-primary">{t('search_key.title')}</h3>
          <p className="text-xs text-text-muted mt-1">{t('search_key.description')}</p>
        </div>
        <RadioGroup
          value={searchKey}
          onValueChange={value => handleSearchKeyChange(value as 'cmd_k' | 'cmd_f' | 'disabled')}
          disabled={isSaving}
          className="space-y-2"
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="cmd_k" id="search-key-cmd-k" />
            <Label htmlFor="search-key-cmd-k" className="text-sm cursor-pointer">
              {t('search_key.option_cmd_k')}
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="cmd_f" id="search-key-cmd-f" />
            <Label htmlFor="search-key-cmd-f" className="text-sm cursor-pointer">
              {t('search_key.option_cmd_f')}
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="disabled" id="search-key-disabled" />
            <Label htmlFor="search-key-disabled" className="text-sm cursor-pointer">
              {t('search_key.option_disabled')}
            </Label>
          </div>
        </RadioGroup>
      </div>

      {/* Restart Onboarding Button */}
      <div className="flex items-center justify-between p-4 bg-base border border-border rounded-lg">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-text-primary">{t('onboarding.restart_tour')}</h3>
          <p className="text-xs text-text-muted mt-1">{t('onboarding.step1_description')}</p>
        </div>
        <Button onClick={handleRestartOnboarding} variant="default" size="default">
          {t('onboarding.restart_tour')}
        </Button>
      </div>
    </div>
  );
}
