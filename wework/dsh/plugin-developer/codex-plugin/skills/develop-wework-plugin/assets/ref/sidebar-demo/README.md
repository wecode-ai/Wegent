# Sidebar browser panel

This minimal Core DSH plugin adds one left-navigation item. Selecting it opens
or reuses a right workspace-sidebar tab and renders the configured website
through the Wework built-in browser without changing the current workspace tab.

Copy this directory when the requested plugin only needs to expose a website:

1. Rename the package, Cordis bundle id, sidebar-tab id, and navigation id.
2. Replace the label, description, icon, and URL.
3. Keep the tab and navigation ids stable so repeated clicks reuse the same
   right-side panel.
4. Add a nested Codex plugin only if the product also needs Codex Skills, MCP
   servers, agents, or other Codex resources.

The right-sidebar contribution is descriptor-only. `mode: 'iframe'` delegates
the website surface to the host; Wework desktop renders it with the managed
built-in browser WebView.
