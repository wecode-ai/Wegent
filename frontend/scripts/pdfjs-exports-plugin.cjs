// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const PDFJS_MODULE =
  /[/\\]pdfjs-dist[/\\](?:legacy[/\\])?(?:build[/\\]pdf(?:\.worker)?|web[/\\]pdf_viewer)(?:\.min)?\.mjs$/
const PLUGIN_NAME = 'PdfJsExportsPlugin'

class PdfJsExportsPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap(PLUGIN_NAME, compilation => {
      compilation.hooks.succeedModule.tap(PLUGIN_NAME, module => {
        if (!PDFJS_MODULE.test(module.resource || '')) return

        // PDF.js declares its own __webpack_exports__ inside its distributed
        // bundle. A strict eval scope hoists that declaration over webpack's
        // injected exports argument. Give only these modules a distinct outer
        // argument; keep their source, workers and other modules unchanged.
        module.buildInfo.exportsArgument = '__pdfjs_module_exports__'
      })
    })
  }
}

module.exports = PdfJsExportsPlugin
