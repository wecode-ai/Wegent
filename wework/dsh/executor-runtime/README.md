# Wework DSH Executor Runtime

This plugin is the unified execution plane for Wework DSH apps. Browser code
only accesses versioned same-origin endpoints and never receives Electron IPC,
executor stdio, or bearer credentials.

The physical transport currently uses the migration-only Electron loopback
relay. The logical client, structured errors, event sequencing, bounded ring
buffer, and resume contract are stable so local sockets and the cloud runtime
relay can replace it without changing product apps.
