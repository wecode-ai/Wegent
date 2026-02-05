// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')

// Check if running with Turbopack (development mode with --turbopack flag)
const isTurbopack = process.env.TURBOPACK === '1'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  output: 'standalone',
  // Allow cross-origin requests in development mode
  // This prevents "Cross origin request detected" warning
  allowedDevOrigins: ['localhost:3000'],
  // Transpile node_modules that ship modern JS syntax for iOS 16 Safari compatibility
  transpilePackages: [
    'mermaid',
    '@mermaid-js/parser',
    'framer-motion',
    '@codemirror/view',
    '@codemirror/state',
    '@codemirror/commands',
    '@codemirror/lang-markdown',
    '@codemirror/language',
    '@codemirror/search',
    '@codemirror/theme-one-dark',
    '@replit/codemirror-vim',
    'katex',
  ],
  // Webpack configuration for production builds
  // Note: In development mode with Turbopack, this is not used
  // The warning "Webpack is configured while Turbopack is not" can be safely ignored
  // as these optimizations are primarily for production builds which use webpack
  ...(isTurbopack
    ? {}
    : {
        webpack: (config, { isServer, _dev }) => {
          // Force replace remark-gfm with our iOS 16 compatible version
          // This is needed because @uiw/react-md-editor depends on remark-gfm
          // which uses lookbehind regex not supported by iOS 16
          config.resolve.alias = {
            ...config.resolve.alias,
            'remark-gfm': path.resolve(__dirname, 'src/lib/remark-gfm-safe.ts'),
          }

          // Handle chunk loading issues
          config.optimization = {
            ...config.optimization,
            // Prevent over-aggressive code splitting that can cause chunk loading errors
            splitChunks: {
              ...config.optimization?.splitChunks,
              chunks: 'all',
              cacheGroups: {
                vendor: {
                  test: /[\\/]node_modules[\\/]/,
                  name: 'vendors',
                  chunks: 'all',
                  priority: 10,
                },
                common: {
                  name: 'common',
                  minChunks: 2,
                  chunks: 'all',
                  priority: 5,
                },
              },
            },
            // Enable module concatenation to reduce bundle size
            concatenateModules: true,
          }

          // Handle dynamic imports more gracefully
          if (!isServer) {
            config.resolve.fallback = {
              ...config.resolve.fallback,
              fs: false,
              path: false,
            }
          }

          return config
        },
      }),
  // Experimental features to improve stability
  experimental: {
    // Disable CSS chunking to fix Safari/iOS bug where CSS files
    // are incorrectly loaded as <script> tags
    cssChunking: false,
    // Improve chunk loading reliability
    optimizeCss: false,
    // Enable server actions if needed
    serverActions: {
      bodySizeLimit: '2mb',
    },
    // Optimize package imports for large icon libraries and UI components
    // This enables automatic tree-shaking and significantly reduces build time
    optimizePackageImports: [
      // Icon libraries - these are the biggest contributors to slow builds
      'lucide-react',
      'react-icons',
      '@heroicons/react',
      '@tabler/icons-react',
      // Radix UI components
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-slider',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toast',
      '@radix-ui/react-tooltip',
      // Other large libraries
      'date-fns',
      'lodash',
      'lodash-es',
    ],
  },
  // Note: API proxying is now handled by /api/[...path]/route.ts
  // This allows RUNTIME_INTERNAL_API_URL to be read at runtime instead of build time

  // Configure cache headers to prevent Safari aggressive caching issues
  async headers() {
    return [
      {
        // Apply to all routes
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
          {
            key: 'Expires',
            value: '0',
          },
        ],
      },
      {
        // Static assets with hash in filename can be cached longer
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Public assets (fonts, images) - cache with revalidation
        source: '/fonts/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
