# Wework Electron Host plugin

This host-side DeepSeek Harness plugin bridges the DSH process to the Electron
main process through two inherited private pipes. It exposes a versioned,
loopback-only HTTP carrier to the first-party Wework DSH application.

This plugin belongs only to the bundled Core Runtime `0.1.1-rc.2`. The
Workbench Runtime `0.1.0-rc.8` does not contain it and receives no Electron
Host pipe. The new Electron architecture no longer supports `0.1.0-rc.7`.

The plugin provides a typed `ctx.weworkDesktop` Host service for the current
Cordis generation. It exposes narrow domain-grouped capabilities rather than
Electron objects, file descriptors, or authentication tokens. Retained service
references reject calls as soon as their generation is disposed.

The Renderer cannot read the Host Cordis service directly. Browser code keeps
using the same-origin HTTP route for these capabilities and a product plugin
can wrap that route with a client adapter.

Window, tray, and Wework built-in browser events from the Electron main process
share the `desktop.events` capability. The Renderer keeps one non-blocking
500 ms poll for all subscribers, and the Host immediately returns the current
event batch so the same-origin HTTP request channel is never held open. New
desktop events must reuse this stream instead of adding feature-specific
100 ms or 250 ms HTTP polling.

Browser plugins in one DSH page share an origin and JavaScript trust domain.
Therefore the HTTP carrier prevents cross-origin browser access but does not
claim isolation between plugins installed into the same DSH composition.
Untrusted plugins must not be installed into the first-party desktop profile.
