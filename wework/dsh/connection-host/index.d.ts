import type { WeworkConnectionsService } from '@wegent/dsh-plugin-runtime/connections'
declare module '@deepseek-ai/cordis' {
  interface Context {
    weworkConnections: WeworkConnectionsService
  }
}
