---
name: wework-docs
description: Answer Wework usage, setup and troubleshooting questions from bundled documentation, including where to find features, buttons, menus and settings. Use for “某功能在哪”, “这个应用怎么用”, or “如何配置你” when they refer to Wework. Do not use for ordinary coding tasks, document creation, or unrelated OpenAI/Codex product questions.
---

# Wework Docs

Answer Wework product questions from the documentation shipped with this application. Wework is Wegent's desktop workbench; a Codex runtime inside Wework does not make Codex or ChatGPT documentation authoritative for Wework's menus, configuration, permissions, or availability.

## Find the relevant documentation

Resolve paths relative to this installed skill directory, never the user's current working directory. The build copies the maintained `docs/{zh,en}/wework/` trees into `references/{zh,en}/`; no repository checkout, network connection, account, or API key is needed to read them.

Use Chinese sources for Chinese questions and English sources for English questions. Read the smallest matching page and relevant sections first. For broad orientation start with [中文索引](references/zh/README.md) or [English index](references/en/README.md). Search within that language's references only when the topic is unclear or the initial page leaves a specific gap.

| Topic                                               | Page within `references/zh/` or `references/en/` |
| --------------------------------------------------- | ------------------------------------------------ |
| Feature locations, UI regions, missing menu entries | `interface-navigation.md`                        |
| First launch and setup                              | `getting-started.md`                             |
| Local directories, Git projects, workspaces         | `projects.md`                                    |
| Conversations, attachments, Skills, task controls   | `tasks.md`                                       |
| Files, terminal, diffs, code review                 | `workbench.md`                                   |
| Wework built-in browser                             | `browser.md`                                     |
| Local, cloud, and remote execution devices          | `devices.md`                                     |
| Plugins, installation, authorization, Skills        | `plugins-and-skills.md`                          |
| Preferences, storage, configuration                 | `settings.md`                                    |
| Model configuration                                 | `user-guide/model-settings.md`                   |
| Project AI manager                                  | `project-ai-manager.md`                          |
| Personal stand-in                                   | `personal-stand-in.md`                           |
| Git hosting connections                             | `git-connections.md`                             |
| Errors and recovery                                 | `troubleshooting.md`                             |
| Wework HTTP API                                     | `api.md`                                         |

Read `developer-guide/` only for an actual integration, architecture, plugin-development, or diagnostic question. Keep developer internals out of ordinary usage answers. Follow links only when their content is needed; a referenced document outside the bundled tree may be unavailable. If a reference is missing, report the documentation gap instead of inventing its content or assuming a developer's filesystem path.

## Answer with evidence

- For “where is it”, “how do I open it”, or missing-entry questions, start with `interface-navigation.md`, then read the linked topic only as needed. Give the visible starting region and click sequence, plus relevant visibility conditions (desktop, experimental features, feature mode, connection, device, project role or plugin state). Internal routes in the index are maintenance identifiers, not browser URLs. If the documented entry does not match the user's screen, ask for their version, platform and current page or screenshot; do not invent a location or assume missing authorization.
- For an individual switch, field or menu action, follow the index's feature links into the owning topic and explain steps, save/activation behavior and limitations. A top-level page name alone is not an answer to how that control works. Source-ownership comments support maintenance, not user instructions or proof that every dynamic control was checked.
- Lead with the answer or exact UI path, followed by the steps needed for the user's task. Cite the installed document with a Markdown link to its absolute path, and name the relevant section when useful. Do not cite an unread page or invent a public documentation URL.
- Treat these pages as the documentation snapshot shipped with this Wework build. They do not establish the latest release, current pricing, account entitlements, or rollout status. Preserve experimental, planned, and unreleased qualifications in the source.
- Separate documented product support from tools actually callable in this conversation. If a verified capability differs from the documentation, state the discrepancy and describe the observed environment without generalizing to every installation.
- Keep project-space storage, code-workspace location, executor device, and conversation lifecycle distinct. A cloud project does not imply cloud execution; access to a model does not imply access to a connector or another device.
- When evidence is insufficient, state what remains unknown. For troubleshooting, use the documented checks and the user's exact error before recommending a change; reading docs does not authorize inspecting credentials, changing configuration, or clearing application data.

## Continue an action request

If the user asks to find, inspect or recover their Wework tasks, first follow the wework-runtime `conversations` skill and discover `wework_control`. Standalone tasks are conversations; query with `include_archived: true` for missing or archived tasks before claiming there is no recovery capability. A manual Settings path does not fulfill an available lookup or restoration action. Use `wework_control` for other conversation and personal schedule operations, `wework_space` for project spaces and Issues, Wework built-in browser tools for web actions, and the applicable plugin's tools for its service. Discover deferred capabilities when needed. Documentation is guidance, not execution permission or proof of success; never bypass a tool denial with shell commands, direct storage reads, or another channel.
