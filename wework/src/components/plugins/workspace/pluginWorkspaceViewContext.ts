import type { PluginsWorkspaceController } from './usePluginsWorkspaceController'
import type { renderPluginWorkspaceDialogs } from './renderPluginWorkspaceDialogs'
export type PluginsWorkspaceViewContext = PluginsWorkspaceController &
  ReturnType<typeof renderPluginWorkspaceDialogs>
