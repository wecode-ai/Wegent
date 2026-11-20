import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'
import type { ViteDevServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))

const config: StorybookConfig = {
  stories: [
    '../src/stories/**/*.stories.tsx',
    '../../packages/collaboration/src/project-assistant-status/*.stories.tsx',
    '../../packages/collaboration/src/workspace-header/*.stories.tsx',
  ],
  addons: ['@storybook/addon-docs', '@storybook/addon-mcp'],
  framework: {
    name: '@storybook/react-vite',
    // Component previews must not prepare native runtimes or load desktop plugins.
    options: { builder: { viteConfigPath: path.resolve(root, '.storybook/vite.config.ts') } },
  },
  core: { disableTelemetry: true },
  features: { componentsManifest: true },
  async viteFinal(config) {
    const { mergeConfig } = await import('vite')
    return mergeConfig(config, {
      server: { watch: { usePolling: true, interval: 1000 } },
      plugins: [
        {
          name: 'storybook-workspace-components',
          configureServer(server: ViteDevServer) {
            server.watcher.add([
              path.resolve(root, '../packages/collaboration/src'),
              path.resolve(root, '../packages/chat-core/src'),
            ])
          },
        },
      ],
      resolve: {
        alias: {
          '@': path.resolve(root, 'src'),
          '@extensions': path.resolve(root, 'src/extensions'),
        },
        dedupe: ['react', 'react-dom'],
      },
    })
  },
}

export default config
