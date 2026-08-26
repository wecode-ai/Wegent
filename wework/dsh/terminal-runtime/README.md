# Wework Core DSH terminal runtime

This first-party Core DSH plugin owns Wework's local interactive PTY sessions.
The packaged Wework frontend calls its same-origin HTTP/SSE API at
`/wework/terminal/v1`.

The executor remains responsible for task, Codex, local-device and cloud-device
execution. It does not proxy desktop terminal input or output.
