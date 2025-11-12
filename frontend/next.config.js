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
    };

    // Handle dynamic imports more gracefully
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }

    return config;
  },
  // Experimental features to improve stability
  experimental: {
    // Improve chunk loading reliability
    optimizeCss: false,
    // Enable server actions if needed
    serverActions: true,
  },
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
