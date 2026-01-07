// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import tailwindcssAnimate from 'tailwindcss-animate'

const withOpacity = variable => `rgb(var(${variable}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/features/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"PingFang SC"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          '"SF Mono"',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
      colors: {
        // Custom project colors
        base: withOpacity('--color-bg-base'),
        surface: withOpacity('--color-bg-surface'),
        muted: withOpacity('--color-bg-muted'),
        hover: withOpacity('--color-bg-hover'),
        border: withOpacity('--color-border'),
        'border-strong': withOpacity('--color-border-strong'),
        'text-primary': withOpacity('--color-text-primary'),
        'text-secondary': withOpacity('--color-text-secondary'),
        'text-muted': withOpacity('--color-text-muted'),
        'text-inverted': withOpacity('--color-text-inverted'),
        primary: withOpacity('--color-primary'),
        'primary-contrast': withOpacity('--color-primary-contrast'),
        success: withOpacity('--color-success'),
        error: withOpacity('--color-error'),
        warning: 'rgb(245 158 11)', // Tailwind orange-500
        link: withOpacity('--color-link'),
        'code-bg': withOpacity('--color-code-bg'),
        popover: {
          DEFAULT: withOpacity('--color-popover'),
          foreground: withOpacity('--color-popover-foreground'),
        },
        tooltip: {
          DEFAULT: withOpacity('--color-tooltip'),
          foreground: withOpacity('--color-tooltip-foreground'),
        },
        // shadcn/ui standard color aliases (mapped to project colors)
        background: withOpacity('--color-bg-base'),
        foreground: withOpacity('--color-text-primary'),
        card: {
          DEFAULT: withOpacity('--color-bg-surface'),
          foreground: withOpacity('--color-text-primary'),
        },
        secondary: {
          DEFAULT: withOpacity('--color-bg-muted'),
          foreground: withOpacity('--color-text-secondary'),
        },
        accent: {
          DEFAULT: withOpacity('--color-bg-hover'),
          foreground: withOpacity('--color-text-primary'),
        },
        destructive: {
          DEFAULT: withOpacity('--color-error'),
          foreground: withOpacity('--color-text-inverted'),
        },
        'muted-foreground': withOpacity('--color-text-muted'),
        input: withOpacity('--color-border'),
        ring: withOpacity('--color-focus-ring'),
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
