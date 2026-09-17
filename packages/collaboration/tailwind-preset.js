/** Shared semantic utilities used by collaboration components in both hosts. */
export default {
  plugins: [
    ({ addComponents }) =>
      addComponents({
        '.heading-xl': {
          'font-size': 'var(--text-xl)',
          'font-weight': '500',
          'line-height': '1.2',
        },
        '.heading-lg': {
          'font-size': 'var(--text-heading-lg)',
          'font-weight': '500',
          'line-height': '1.2',
        },
        '.heading-medium': {
          'font-size': 'var(--text-xl)',
          'font-weight': '500',
          'letter-spacing': '-0.025em',
          'line-height': '1.2',
        },
        '.heading-base': {
          'font-size': 'var(--text-heading-md)',
          'font-weight': '500',
          'line-height': '1.33',
        },
        '.heading-subsection': {
          'font-size': 'var(--text-heading-sm)',
          'font-weight': '500',
          'line-height': '1.33',
        },
        '.heading-dialog': {
          'font-size': 'var(--text-heading-md)',
          'font-weight': '500',
          'letter-spacing': '-0.018em',
          'line-height': '1.4',
        },
        '.heading-sm': {
          'font-size': 'var(--text-sm)',
          'font-weight': '500',
          'line-height': '1.4',
        },
        '.heading-xs': {
          'font-size': 'var(--text-xs)',
          'font-weight': '500',
          'line-height': '1.4',
        },
      }),
  ],
  theme: {
    extend: {
      colors: {
        'reasoning-standard': 'rgb(var(--color-reasoning-standard) / <alpha-value>)',
        'reasoning-ultra-start': 'rgb(var(--color-reasoning-ultra-start) / <alpha-value>)',
        'reasoning-ultra-end': 'rgb(var(--color-reasoning-ultra-end) / <alpha-value>)',
        'reasoning-ultra-text': 'rgb(var(--color-reasoning-ultra-text) / <alpha-value>)',
        'reasoning-contrast': 'rgb(var(--color-reasoning-contrast) / <alpha-value>)',
      },
      fontSize: {
        chat: ['var(--text-chat)', { lineHeight: 'calc(1em + 8px)' }],
        code: ['var(--text-code)', { lineHeight: '1.8' }],
        'code-sm': ['var(--text-code-sm)', { lineHeight: '1.8' }],
      },
      zIndex: {
        chrome: 'var(--z-chrome)',
        popover: 'var(--z-popover)',
        modal: 'var(--z-modal)',
        critical: 'var(--z-critical)',
        system: 'var(--z-system)',
        'system-popover': 'var(--z-system-popover)',
      },
    },
  },
}
