// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { userApis } from '@/apis/user';
import { impersonationApis } from '@/apis/impersonation';
import { User } from '@/types/api';
import { useRouter } from 'next/navigation';
import { paths } from '@/config/paths';
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants';
import { useToast } from '@/hooks/use-toast';

interface UserContextType {
  user: User | null;
  isLoading: boolean;
  logout: () => void;
  refresh: () => Promise<void>;
  login: (data: { user_name: string; password: string }) => Promise<void>;
  // Impersonation support
  isImpersonating: boolean;
  impersonatorName: string | null;
  impersonationExpiresAt: Date | null;
  exitImpersonation: () => Promise<void>;
}
const UserContext = createContext<UserContextType>({
  user: null,
  isLoading: true,
  logout: () => {},
  refresh: async () => {},
  login: async () => {},
  isImpersonating: false,
  impersonatorName: null,
  impersonationExpiresAt: null,
  exitImpersonation: async () => {},
});
export const UserProvider = ({ children }: { children: ReactNode }) => {
  const { toast } = useToast();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Impersonation state
  const [isImpersonating, setIsImpersonating] = useState(false);
  const [impersonatorName, setImpersonatorName] = useState<string | null>(null);
  const [impersonationExpiresAt, setImpersonationExpiresAt] = useState<Date | null>(null);
  // Using antd message.error for unified error handling, no local error state needed

  // Parse JWT token to extract impersonation info
  const parseTokenForImpersonation = () => {
    if (typeof window === 'undefined') return;

    const token = localStorage.getItem('token');
    if (!token) {
      setIsImpersonating(false);
      setImpersonatorName(null);
      setImpersonationExpiresAt(null);
      return;
    }

    try {
      // Decode JWT payload (base64)
      const parts = token.split('.');
      if (parts.length !== 3) return;

      const payload = JSON.parse(atob(parts[1]));

      if (payload.is_impersonating) {
        setIsImpersonating(true);
        setImpersonatorName(payload.impersonator_name || null);
        // Convert exp timestamp to Date
        if (payload.exp) {
          setImpersonationExpiresAt(new Date(payload.exp * 1000));
        }
      } else {
        setIsImpersonating(false);
        setImpersonatorName(null);
        setImpersonationExpiresAt(null);
      }
    } catch {
      // Invalid token format, ignore
      setIsImpersonating(false);
      setImpersonatorName(null);
      setImpersonationExpiresAt(null);
    }
  };

  const exitImpersonation = async () => {
    try {
      const response = await impersonationApis.exitSession();
      // Store new token
      localStorage.setItem('token', response.access_token);
      // Reset impersonation state
      setIsImpersonating(false);
      setImpersonatorName(null);
      setImpersonationExpiresAt(null);
      // Refresh user data
      await fetchUser();
      // Redirect to admin page
      router.push('/admin');
      toast({ title: response.message });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to exit impersonation',
        description: (error as Error).message,
      });
    }
  };

  const redirectToLogin = () => {
    const loginPath = paths.auth.login.getHref();
    if (typeof window === 'undefined') {
      router.replace(loginPath);
      return;
    }
    if (window.location.pathname === loginPath) {
      return;
    }
    const disallowedTargets = [loginPath, '/login/oidc'];
    const currentPathWithSearch = `${window.location.pathname}${window.location.search}`;
    const validRedirect = sanitizeRedirectPath(currentPathWithSearch, disallowedTargets);

    if (validRedirect) {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, validRedirect);
      router.replace(`${loginPath}?redirect=${encodeURIComponent(validRedirect)}`);
      return;
    }

    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    router.replace(loginPath);
  };

  const fetchUser = async () => {
    setIsLoading(true);

    try {
      const isAuth = userApis.isAuthenticated();

      if (!isAuth) {
        console.log(
          'UserContext: User not authenticated, clearing user state and redirecting to login'
        );
        setUser(null);
        setIsLoading(false);
        redirectToLogin();
        return;
      }

      const userData = await userApis.getCurrentUser();
      setUser(userData);
      // Parse impersonation info from token
      parseTokenForImpersonation();
    } catch (error) {
      console.error('UserContext: Failed to fetch user information:', error as Error);
      toast({
        variant: 'destructive',
        title: 'Failed to load user',
      });
      setUser(null);
      redirectToLogin();
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();

    // Listen for OIDC login success event
    const handleOidcLoginSuccess = () => {
      console.log('Received OIDC login success event, refreshing user information');
      fetchUser();
    };

    window.addEventListener('oidc-login-success', handleOidcLoginSuccess);

    // Periodically check if token is expired (check every 10 seconds)
    const tokenCheckInterval = setInterval(() => {
      const isAuth = userApis.isAuthenticated();
      if (!isAuth && user) {
        console.log('Token expired, auto logout');
        setUser(null);
        redirectToLogin();
      }
    }, 10000);

    return () => {
      window.removeEventListener('oidc-login-success', handleOidcLoginSuccess);
      clearInterval(tokenCheckInterval);
    };
    // eslint-disable-next-line
  }, []);

  const logout = () => {
    console.log('Executing logout operation');
    userApis.logout();
    setUser(null);
    redirectToLogin();
  };

  const login = async (data: { user_name: string; password: string }) => {
    setIsLoading(true);
    try {
      const userData = await userApis.login(data);
      setUser(userData);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || 'Login failed',
      });
      setUser(null);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <UserContext.Provider
      value={{
        user,
        isLoading,
        logout,
        refresh: fetchUser,
        login,
        isImpersonating,
        impersonatorName,
        impersonationExpiresAt,
        exitImpersonation,
      }}
    >
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => useContext(UserContext);
