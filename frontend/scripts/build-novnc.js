#!/usr/bin/env node
// Build script to create browser-compatible noVNC bundle
// Produces public/novnc/rfb.min.js which exposes window.noVNC as RFB constructor
//
// noVNC 1.6.0 ships as CJS but has a top-level await in util/browser.js (line 179).
// Webpack only supports top-level await in ESM mode, but ESM mode breaks CJS exports.
//
// Solution: Use a custom inline webpack loader to patch out the top-level await
// in browser.js at build time, then bundle with standard CJS mode.

const path = require('path')
const webpack = require('webpack')

// Custom inline loader that removes the top-level await from browser.js
const patchLoaderPath = path.resolve(__dirname, '../public/novnc/patch-loader.js')
const fs = require('fs')
fs.writeFileSync(
  patchLoaderPath,
  `module.exports = function(source) {
  // Replace top-level await with .then() pattern
  // Original: exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();
  // Patched: async .then() that sets the value after resolution (initial value stays undefined)
  return source.replace(
    /exports\\.supportsWebCodecsH264Decode\\s*=\\s*supportsWebCodecsH264Decode\\s*=\\s*await\\s+_checkWebCodecsH264DecodeSupport\\(\\);/,
    '_checkWebCodecsH264DecodeSupport().then(function(v) { exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = v; });'
  );
};
`
)

const config = {
  mode: 'production',
  entry: path.resolve(__dirname, '../public/novnc/novnc-bundle.js'),
  output: {
    path: path.resolve(__dirname, '../public/novnc'),
    filename: 'rfb.min.js',
    library: {
      name: 'noVNC',
      type: 'window',
    },
  },
  module: {
    rules: [
      {
        // Apply patch loader only to browser.js to remove top-level await
        test: /browser\.js$/,
        include: /node_modules[\\/]@novnc[\\/]novnc[\\/]lib[\\/]util/,
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
