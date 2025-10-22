// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const withOpacity = (variable) => `rgb(var(${variable}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/features/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        base: withOpacity('--color-bg-base'),
        surface: withOpacity('--color-bg-surface'),
        muted: withOpacity('--color-bg-muted'),
        border: withOpacity('--color-border'),
        'border-strong': withOpacity('--color-border-strong'),
        'text-primary': withOpacity('--color-text-primary'),
        'text-secondary': withOpacity('--color-text-secondary'),
        'text-muted': withOpacity('--color-text-muted'),
        'text-inverted': withOpacity('--color-text-inverted'),
        primary: withOpacity('--color-primary'),
        'primary-contrast': withOpacity('--color-primary-contrast'),
      },
    },
  },
  plugins: [],
}
