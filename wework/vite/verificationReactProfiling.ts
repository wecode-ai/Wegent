import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

/** Production verification needs React's profiling renderer for commit evidence. */
export function verificationReactProfiling(): Plugin {
  return {
    name: 'wework-verification-react-profiling',
    apply: 'build',
    config: () => ({
      resolve: {
        alias: [
          {
            find: /^react-dom\/client$/,
            replacement: createRequire(import.meta.url).resolve('react-dom/profiling'),
          },
        ],
      },
    }),
  }
}
