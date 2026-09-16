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
    './wecode/**/*.{js,ts,jsx,tsx,mdx}',
    '../packages/collaboration/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    fontSize: {
      xs: ['var(--text-xs)', { lineHeight: '1.333333' }],
      sm: ['var(--text-sm)', { lineHeight: '1.428571' }],
      base: ['var(--text-base)', { lineHeight: '1.5' }],
      lg: ['var(--text-lg)', { lineHeight: '1.555556' }],
      xl: ['var(--text-xl)', { lineHeight: '1.4' }],
      '2xl': ['var(--text-2xl)', { lineHeight: '1.333333' }],
      '3xl': ['var(--text-3xl)', { lineHeight: '1.2' }],
      '4xl': ['var(--text-4xl)', { lineHeight: '1.111111' }],
      'heading-sm': ['var(--text-heading-sm)', { lineHeight: '1.33' }],
      'heading-md': ['var(--text-heading-md)', { lineHeight: '1.33' }],
      'heading-lg': ['var(--text-heading-lg)', { lineHeight: '1.2' }],
    },
    extend: {
      fontFamily: {
        sans: ['var(--font-ui)'],
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
        // Custom project colors - Wegent Purple Theme
        base: withOpacity('--color-bg-base'),
        surface: withOpacity('--color-bg-surface'),
        muted: withOpacity('--color-bg-muted'),
        hover: withOpacity('--color-bg-hover'),
        border: withOpacity('--color-border'),
        'border-strong': withOpacity('--color-border-strong'),
        'border-light': withOpacity('--color-border-light'),
        'text-primary': withOpacity('--color-text-primary'),
        'text-secondary': withOpacity('--color-text-secondary'),
        'text-muted': withOpacity('--color-text-muted'),
        'text-inverted': withOpacity('--color-text-inverted'),
        primary: withOpacity('--color-primary'),
        'primary-contrast': withOpacity('--color-primary-contrast'),
        focus: withOpacity('--color-focus'),
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
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        sidebar: 'var(--shadow-sidebar)',
        popover: 'var(--shadow-popover)',
        'card-hover': '0 4px 24px rgba(93, 94, 201, 0.06)',
        'input-focus': '0 0 0 2px rgba(93, 94, 201, 0.2)',
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
        timerPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        checkPop: {
          '0%': { transform: 'scale(0)' },
          '60%': { transform: 'scale(1.15)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        timerPulse: 'timerPulse 1s ease-in-out infinite',
        slideDown: 'slideDown 0.35s ease-out',
        fadeIn: 'fadeIn 0.3s ease-out',
        scaleIn: 'scaleIn 0.25s ease-out',
        checkPop: 'checkPop 0.4s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
