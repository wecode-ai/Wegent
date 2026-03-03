#!/usr/bin/env node
// Build script to create browser-compatible noVNC bundle

const path = require('path')
const webpack = require('webpack')

const config = {
  mode: 'production',
  entry: path.resolve(__dirname, '../public/novnc/novnc-bundle.js'),
  output: {
    path: path.resolve(__dirname, '../public/novnc'),
    filename: 'rfb.min.js',
    library: {
      name: 'noVNC',
      type: 'window',
      export: 'default',
    },
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        include: /node_modules[\\/]@novnc[\\/]novnc/,
        type: 'javascript/auto',
      },
    ],
  },
  experiments: {
    topLevelAwait: true,
  },
}

webpack(config, (err, stats) => {
  if (err || stats.hasErrors()) {
    console.error('Build failed:', err || stats.toString())
    process.exit(1)
  }
  console.log('Build complete!')
})
