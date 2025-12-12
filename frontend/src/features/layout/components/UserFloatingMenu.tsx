// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useUser } from '@/features/common/UserContext';
import { useTranslation } from '@/hooks/useTranslation';
import { DocsButton } from '@/features/layout/DocsButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { paths } from '@/config/paths';
import {
  UserCircleIcon,
  Cog6ToothIcon,
  ArrowRightOnRectangleIcon,
  ChevronUpIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';

interface UserFloatingMenuProps {
  className?: string;
}

export function UserFloatingMenu({ className = '' }: UserFloatingMenuProps) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { user, logout } = useUser();
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const userDisplayName = user?.user_name || t('user.default_name');
  const isAdmin = user?.role === 'admin';

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsExpanded(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsExpanded(false);
    }, 150);
  };

  const handleSettingsClick = () => {
    router.push(paths.settings.root.getHref());
    setIsExpanded(false);
  };

  const handleLogout = () => {
    logout();
    setIsExpanded(false);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* User avatar button */}
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted transition-all duration-200 group"
      >
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <UserCircleIcon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex flex-col items-start">
          <span className="text-sm font-medium text-text-primary leading-tight">
            {userDisplayName}
          </span>
          {isAdmin && (
            <span className="text-xs text-primary flex items-center gap-0.5">
              <ShieldCheckIcon className="w-3 h-3" />
              Admin
            </span>
          )}
        </div>
        <ChevronUpIcon
          className={`w-3.5 h-3.5 text-text-muted transition-transform duration-200 ${
            isExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Expanded menu */}
      <div
        className={`absolute bottom-full left-0 mb-2 min-w-[200px] rounded-xl bg-surface border border-border overflow-hidden transition-all duration-200 ease-out ${
          isExpanded
            ? 'opacity-100 translate-y-0 pointer-events-auto'
            : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        {/* Menu items */}
        <div className="py-1">
          {/* Settings */}
          <button
            type="button"
            onClick={handleSettingsClick}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
          >
            <Cog6ToothIcon className="w-4 h-4 text-text-muted" />
            {t('navigation.settings')}
          </button>

          {/* Docs */}
          <DocsButton showLabel className="w-full px-3 py-2" onClick={() => setIsExpanded(false)} />

          {/* Theme toggle */}
          <ThemeToggle
            showLabel
            className="w-full px-3 py-2"
            onToggle={() => setIsExpanded(false)}
          />

          {/* Admin link */}
          {isAdmin && (
            <>
              <div className="my-1 mx-2 h-px bg-border/60" />
              <Link href="/admin">
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
                >
                  <ShieldCheckIcon className="w-4 h-4 text-primary" />
                  {t('navigation.admin', 'Admin')}
                </button>
              </Link>
            </>
          )}

          {/* Logout */}
          <div className="my-1 mx-2 h-px bg-border/60" />
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
          >
            <ArrowRightOnRectangleIcon className="w-4 h-4 text-text-muted" />
            {t('user.logout')}
          </button>
        </div>
      </div>
    </div>
  );
}
