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
import {
  getSendShortcutMode,
  setSendShortcutMode,
  type SendShortcutMode,
} from '@/utils/sendShortcut';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

export default function NotificationSettings() {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(true);
  const [sendShortcut, setSendShortcut] = useState<SendShortcutMode>('enter');

  useEffect(() => {
    setSupported(isNotificationSupported());
    setEnabled(isNotificationEnabled());
    setSendShortcut(getSendShortcutMode());
  }, []);

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

  const handleSendShortcutChange = (value: SendShortcutMode) => {
    setSendShortcut(value);
    setSendShortcutMode(value);
    // Dispatch storage event for same-tab updates
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'wegent_send_shortcut_mode',
        newValue: value,
      })
    );
    toast({
      title: t('send_shortcut.change_success'),
    });
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

      {/* Send Shortcut Setting */}
      <div className="p-4 bg-base border border-border rounded-lg">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-text-primary">{t('send_shortcut.title')}</h3>
          <p className="text-xs text-text-muted mt-1">{t('send_shortcut.description')}</p>
        </div>
        <RadioGroup
          value={sendShortcut}
          onValueChange={(value: SendShortcutMode) => handleSendShortcutChange(value)}
          className="flex flex-col gap-3"
        >
          <div className="flex items-center space-x-3">
            <RadioGroupItem value="enter" id="enter" />
            <Label htmlFor="enter" className="text-sm text-text-primary cursor-pointer">
              {t('send_shortcut.enter_option')}
            </Label>
          </div>
          <div className="flex items-center space-x-3">
            <RadioGroupItem value="cmd-enter" id="cmd-enter" />
            <Label htmlFor="cmd-enter" className="text-sm text-text-primary cursor-pointer">
              {t('send_shortcut.cmd_enter_option')}
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
