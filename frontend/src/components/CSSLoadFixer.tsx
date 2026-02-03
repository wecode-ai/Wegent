'use client'

import { useEffect } from 'react'

/**
 * Fixes a Next.js 15 bug where CSS files are incorrectly loaded as <script> tags
 * on iOS Safari. This component runs early to convert them back to <link> tags.
 *
 * @see https://github.com/vercel/next.js/issues (CSS in build-manifest.json bug)
 */
export function CSSLoadFixer() {
  useEffect(() => {
    // Find all script tags that incorrectly reference CSS files
    document.querySelectorAll('script[src$=".css"]').forEach(script => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = (script as HTMLScriptElement).src
      script.parentNode?.replaceChild(link, script)
    })
  }, [])

  return null
}
