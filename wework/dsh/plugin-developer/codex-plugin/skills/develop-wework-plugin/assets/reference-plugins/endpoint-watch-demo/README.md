# Endpoint Watch

A real host-integration example inspired by REST clients, live-preview tools,
and service monitoring plugins.

After installation and a Core DSH restart:

- Open **Endpoint Watch** from the sidebar.
- Enter an HTTP or HTTPS URL and run a check.
- The plugin loads the URL in a Wework background browser page and reports the
  navigation status, title, duration, and recent history.
- Use the workspace toolbar action to repeat the configured check.

The example uses only the typed `ctx.wework.host.browser` and notification
capabilities.
