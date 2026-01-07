// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const initThemeScript = `(() => {
  try {
    const storageKey = 'wegent.theme';
    const stored = window.localStorage.getItem(storageKey);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
    const root = document.documentElement;
    root.dataset.theme = theme;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  } catch (error) {
    // ignore errors in early boot
  }
})();`

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: initThemeScript }} suppressHydrationWarning />
}
