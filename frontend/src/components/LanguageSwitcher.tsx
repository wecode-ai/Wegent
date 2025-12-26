// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslation, languageNames } from '@/hooks/useTranslation';
import { ChevronDownIcon, LanguageIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

interface LanguageSwitcherProps {
  className?: string;
  showLabel?: boolean;
  /** Menu item mode for use in menus like UserFloatingMenu */
  menuItemMode?: boolean;
  /** Callback when language is changed (for menu mode) */
  onLanguageChange?: () => void;
}

export default function LanguageSwitcher({
  className = '',
  showLabel = true,
  menuItemMode = false,
  onLanguageChange,
}: LanguageSwitcherProps) {
  const { t, changeLanguage, getCurrentLanguage, getSupportedLanguages } = useTranslation('common');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentLanguage = getCurrentLanguage();
  const supportedLanguages = getSupportedLanguages();

  const handleLanguageChange = (language: string) => {
    changeLanguage(language);
    setIsOpen(false);
    onLanguageChange?.();
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Menu item mode - renders as a menu item with submenu
  if (menuItemMode) {
    return (
      <div ref={containerRef} className={`relative ${className}`}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
        >
          <div className="flex items-center gap-3">
            <LanguageIcon className="w-4 h-4 text-text-muted" />
            <span>{t('navigation.language', 'Language')}</span>
          </div>
          <div className="flex items-center gap-1 text-text-muted">
            <span className="text-xs">{languageNames[currentLanguage] || currentLanguage}</span>
            <ChevronRightIcon className="w-3 h-3" />
          </div>
        </button>

        {isOpen && (
          <div
            className="absolute left-full top-0 ml-1 min-w-[120px] bg-surface border border-border rounded-lg overflow-hidden"
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            <div className="py-1">
              {supportedLanguages.map(language => (
                <button
                  key={language}
                  onClick={() => handleLanguageChange(language)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-muted ${
                    currentLanguage === language
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-text-primary'
                  }`}
                >
                  {languageNames[language] || language}
                  {currentLanguage === language && <span className="ml-2 text-primary">✓</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Default dropdown mode
  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 px-3 py-2 text-sm font-medium text-text-primary bg-surface border border-border rounded-md hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <LanguageIcon className="w-4 h-4" />
        {showLabel && <span>{languageNames[currentLanguage] || currentLanguage}</span>}
        <ChevronDownIcon className="w-4 h-4" />
      </button>

      {isOpen && (
        <>
          {/* Dropdown menu with higher z-index to ensure it's above the overlay */}
          <div
            className="absolute right-0 z-30 mt-2 w-48 bg-surface border border-border rounded-md shadow-lg max-h-60 overflow-y-auto"
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            <div className="py-1">
              {supportedLanguages.map(language => (
                <button
                  key={language}
                  onClick={() => handleLanguageChange(language)}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-muted ${
                    currentLanguage === language
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-text-primary'
                  }`}
                >
                  {languageNames[language] || language}
                  {currentLanguage === language && <span className="ml-2 text-primary">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
