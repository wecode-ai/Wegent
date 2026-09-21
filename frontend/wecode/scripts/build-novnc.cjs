#!/usr/bin/env node
// Build script to create browser-compatible noVNC bundle
// Produces public/novnc/rfb.min.js which exposes window.noVNC as RFB constructor
//
// noVNC ships with a top-level await in util/browser.js.
// Webpack can parse it, but producing a classic script bundle for runtime loading
// is simpler if the feature check updates asynchronously instead.
//
// Solution: Use a custom inline webpack loader to patch out the top-level await
// in browser.js at build time, then expose the RFB constructor on window.noVNC.

const path = require('path')
const webpack = require('webpack')

// Custom inline loader that removes the top-level await from browser.js
const patchLoaderPath = path.resolve(__dirname, '../../public/novnc/patch-loader.js')
const fs = require('fs')
fs.mkdirSync(path.dirname(patchLoaderPath), { recursive: true })
fs.writeFileSync(
  patchLoaderPath,
  `module.exports = function(source) {
  // Replace top-level await with .then() pattern
  // noVNC 1.6 used CJS exports; noVNC 1.7 uses ESM assignment.
  // Patched: async .then() that sets the value after resolution.
  return source
    .replace(
    /exports\\.supportsWebCodecsH264Decode\\s*=\\s*supportsWebCodecsH264Decode\\s*=\\s*await\\s+_checkWebCodecsH264DecodeSupport\\(\\);/,
    '_checkWebCodecsH264DecodeSupport().then(function(v) { exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = v; });'
    )
    .replace(
      /supportsWebCodecsH264Decode\\s*=\\s*await\\s+_checkWebCodecsH264DecodeSupport\\(\\);/,
      '_checkWebCodecsH264DecodeSupport().then(function(v) { supportsWebCodecsH264Decode = v; });'
    );
};
`
)

const config = {
  mode: 'production',
  entry: path.resolve(__dirname, '../assets/novnc-bundle.js'),
  output: {
    path: path.resolve(__dirname, '../../public/novnc'),
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
        // Apply patch loader only to browser.js to remove top-level await
        test: /browser\.js$/,
        include: /node_modules[\\/]@novnc[\\/]novnc[\\/](lib|core)[\\/]util/,
        use: [patchLoaderPath],
      },
    ],
  },
}

webpack(config, (err, stats) => {
  // Clean up patch loader
  try {
    fs.unlinkSync(patchLoaderPath)
  } catch {
    // ignore
  }

  if (err || stats.hasErrors()) {
    console.error('Build failed:', err || stats.toString({ colors: true }))
    process.exit(1)
  }
  console.log('[noVNC] Bundle built successfully: public/novnc/rfb.min.js')
})
