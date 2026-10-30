---
sidebar_position: 35
---

# MCP Apps

Wework runs MCP Apps alongside tool results in Codex tasks. An MCP server supplies HTML, and the app communicates with Wework through the standard MCP Apps protocol.

## Declare a UI

Set `_meta.ui.resourceUri` on the tool definition and serve that resource through `resources/read` with the `text/html;profile=mcp-app` MIME type. Put network requirements in the resource's `_meta.ui.csp` metadata.

The host also accepts `ui/resourceUri`, `openai/outputTemplate`, and resource references in result metadata. Legacy `text/html+skybridge` widgets use a `window.openai` adapter over the same host channel.

An invocation loads an MCP App only when its record, tool definition, or result metadata declares a UI resource. Ordinary tools without a UI resource do not show app cards, including historical calls whose server or tool has been removed. Apps with a declared UI resource still report unavailable sources or resource-loading errors. Ordinary invocations cannot use app-only tool, resource, or context methods.

## Communication and lifecycle

After the initialization handshake, apps receive tool arguments and results. The executor preserves JSON object insertion order when forwarding opaque app metadata, including manifests whose serialized bytes are checked by the app. The host preserves `content`, `structuredContent`, and `_meta` separately and does not add result metadata to model context.

Transcript refreshes do not resend equivalent tool results to an initialized app, preserving state updated by app tool callbacks. Changes to result content or error status still send an update.

Apps can call their source server's tools, read resources, send conversation messages, update model context, and request inline, fullscreen, or picture-in-picture presentation. Read-only Issue execution views omit app conversation messaging; replies still originate from the Issue. Other conversation messages require confirmation. App tool calls use the source-bound native Codex channel without an additional annotation-based confirmation dialog. App-only tools remain callable by apps; model-only tools are excluded.

State-preserving DOM moves keep app browsing contexts alive when virtualized tool rows leave the viewport. Closing an app or leaving its task releases the bridge and temporary document. Model context is stored by source invocation and included in later messages as untrusted app data.

The desktop workbench supports both inline conversation cards and right-side app tabs. A fullscreen request uses the right workspace container. Expanding and restoring move the same sandbox node, preserving input, login state, and in-flight requests. Closing the right-side tab restores apps that support inline presentation to the conversation. Fullscreen-only apps retain their document and collapse to a reopening control. Closing the app itself releases its document.

## Security boundaries

- The executor derives authority from a real invocation in the owning task. Apps cannot choose another task, server, plugin, connector, or account.
- Each HTML document receives a unique `codex-sandbox://<id>.web-sandbox.oaiusercontent.com/mcp-app.html` origin. Electron handles this scheme locally; no DNS lookup, OpenAI request, or remote execution is involved. Documents have no workbench DOM, cookies, storage, or desktop host APIs.
- Response headers enforce the declared CSP. Undeclared network and child-frame requests are blocked. Insecure HTTP is restricted to explicitly declared local development origins.
- Messages must match both the source window and document origin. Outbound messages are bound to that origin as well.
- Metadata and model context cannot grant permissions. Approval never expands plugin or account scope.

## Verification

```bash
pnpm --filter wework e2e:desktop --segment mcp-apps
```

The desktop CI checkpoint uses real Electron, executor, Codex, and stdio MCP components; only model responses are simulated. It covers resource loading, initialization, private metadata delivery, app-only callbacks, model context, display transitions, source isolation, repeated non-read-only callbacks, scope denial, and cleanup. The ordinary-tool regression also disables the source server, restarts the real Codex service, and reopens the historical conversation to verify that no app error card appears and app-only requests remain denied.
