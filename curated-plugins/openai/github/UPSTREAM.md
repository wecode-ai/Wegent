# OpenAI GitHub plugin adaptation

This directory is a reviewed snapshot of `plugins/github` from
<https://github.com/openai/plugins>. The exact source revision is recorded in
`upstream.lock.json`.

Wegent keeps the OpenAI-authored skills and helper scripts unchanged. The
adapter only:

- removes the OpenAI App identifier and package-local MCP configuration;
- declares the `github` Wegent connector with `on_install` authorization;
- routes OAuth and MCP credentials through Wegent Connector Runtime; and
- uses an icon that is present in the upstream package.

GitHub access tokens are never included in this directory or in its published
ZIP. The original license declarations and per-skill license files must remain
present when updating the snapshot.
