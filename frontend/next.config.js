// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  output: 'standalone',
  // Optimize webpack configuration to prevent chunk loading errors
  webpack: (config, { isServer, _dev }) => {
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
  // Experimental features to improve stability
  experimental: {
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
}

module.exports = nextConfig
