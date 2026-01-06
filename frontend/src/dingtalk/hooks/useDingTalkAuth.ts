// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk authentication hook.
 */
import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { requestAuthCode } from '../lib/dingtalk-sdk';
import { getDingTalkConfig } from '../lib/environment';
import { setToken } from '@/apis/user';
import { apiClient } from '@/apis/client';
import { paths } from '@/config/paths';
import { getLastTab } from '@/utils/userPreferences';

interface DingTalkLoginResponse {
  access_token: string;
  user: {
    id: number;
    user_name: string;
    email: string;
    role: string;
    auth_source: string;
  };
}

export function useDingTalkAuth() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const config = getDingTalkConfig();

      // Step 1: Get auth code from DingTalk
      const authCode = await requestAuthCode(config.corpId, config.clientId);

      // Step 2: Exchange auth code for JWT token
      const data: DingTalkLoginResponse = await apiClient.post('/auth/dingtalk/login', {
        auth_code: authCode,
      });

      // Step 3: Store token
      setToken(data.access_token);

      // Step 4: Redirect to chat or code based on user preference
      const lastTab = getLastTab();
      if (lastTab === 'code') {
        router.replace(paths.code.getHref());
      } else {
        router.replace(paths.chat.getHref());
      }

      return data.user;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [router]);

  return { login, loading, error };
}
