// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import Image from 'next/image';
import { Bars3Icon } from '@heroicons/react/24/outline';

import { useTranslation } from '@/hooks/useTranslation';
import { useIsMobile, useIsDesktop } from './hooks/useMediaQuery';
import { MobileNavTabs } from './components/MobileNavTabs';
import { DesktopNavLinks } from './components/DesktopNavLinks';

type TopNavigationProps = {
  activePage: 'chat' | 'code' | 'wiki' | 'dashboard';
  variant?: 'with-sidebar' | 'standalone';
  showLogo?: boolean;
  children?: React.ReactNode;
  onMobileSidebarToggle?: () => void;
};

export default function TopNavigation({
  activePage,
  variant = 'standalone',
  showLogo = false,
  children,
  onMobileSidebarToggle,
}: TopNavigationProps) {
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();

  // Determine if we should show the hamburger menu
  const showHamburgerMenu = variant === 'with-sidebar' && !isDesktop && onMobileSidebarToggle;

  // Determine if we should show the logo
  const shouldShowLogo = showLogo || (variant === 'standalone' && !isMobile);

  return (
    <div className="relative flex items-center justify-between px-4 sm:px-6 py-2 sm:py-3 min-h-[44px] border-b border-border bg-base">
      {/* Left side - Mobile sidebar toggle or Logo */}
      <div className="flex items-center">
        {showHamburgerMenu && (
          <button
            type="button"
            className="lg:hidden p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40 bg-surface border border-border"
            onClick={onMobileSidebarToggle}
            aria-label={t('common.open_sidebar')}
          >
            <Bars3Icon className={isMobile ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden="true" />
          </button>
        )}

        {shouldShowLogo && !showHamburgerMenu && (
          <div className="flex items-center gap-2">
            <Image
              src="/weibo-logo.png"
              alt="Weibo Logo"
              width={isMobile ? 20 : 24}
              height={isMobile ? 20 : 24}
              className="object-container"
              priority
            />
            {!isMobile && <span className="text-lg font-semibold text-text-primary">Wegent</span>}
          </div>
        )}
      </div>

      {/* Center - Navigation links */}
      <nav
        className="flex-1 flex justify-center items-center"
        aria-label={t('common.main_navigation')}
      >
        {isMobile ? (
          <MobileNavTabs activePage={activePage} />
        ) : (
          <DesktopNavLinks activePage={activePage} />
        )}
      </nav>

      {/* Right side - User menu and theme toggle */}
      {children && <div className="flex items-center gap-2 sm:gap-3">{children}</div>}
    </div>
  );
}
