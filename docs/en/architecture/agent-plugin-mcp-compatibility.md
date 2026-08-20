---
sidebar_position: 31
---

# Agent plugin MCP configuration compatibility

Scope: validation and component indexing of MCP declarations in Agent plugin packages, plus the Harness adapters Wework generates for Claude Code, Kimi Code, and OpenCode. MCP server networking and business tool contracts are outside this topic.

```mermaid
flowchart LR
    ZIP[Plugin ZIP] --> MANIFEST[.codex-plugin/plugin.json]
    MANIFEST --> SOURCE{MCP declaration source}
    SOURCE -->|path| FILE[.mcp.json]
    SOURCE -->|inline object| INLINE[Inline server map]
    FILE --> SHAPE{Declaration shape}
    SHAPE --> DIRECT[Direct server map]
    SHAPE --> STANDARD[mcp_servers wrapper]
    SHAPE --> LEGACY[mcpServers compatibility wrapper]
    INLINE --> CANONICAL[Normalized server map]
    DIRECT --> CANONICAL
    STANDARD --> CANONICAL
    LEGACY --> CANONICAL
    CANONICAL --> PREVIEW[Import preview and component index]
    CANONICAL --> ADAPTER{Harness adapter}
    ZIP --> CODEX[Native Codex plugin host<br/>source package preserved]
    ADAPTER --> CLAUDE[Claude / Kimi<br/>type=http + headers]
    ADAPTER --> OPENCODE[OpenCode<br/>type=remote + headers]
```

```mermaid
sequenceDiagram
    participant U as User
    participant I as Wework Importer
    participant P as MCP Parser
    participant C as Codex Plugin Host
    participant A as Harness Adapter

    U->>I: Select plugin ZIP
    I->>P: Parse manifest and MCP declaration
    P->>P: Accept direct / mcp_servers / mcpServers
    P-->>I: Return server map or an explicit format error
    I-->>U: Show MCP count and risk
    I->>C: Install the original plugin package
    Note over I,C: Codex fields are not rewritten for another Harness
    A->>P: Read the same server map from the installed plugin
    alt command server
        A->>A: Generate the target Harness local-process configuration
    else url server
        A->>A: Infer remote transport and normalize headers/http_headers
    end
    A-->>A: Write the Claude, Kimi, or OpenCode adapter
```

| Edge                          | Code ownership                                          |
| ----------------------------- | ------------------------------------------------------- |
| ZIP to import preview         | Wework Tauri `local_executor`                           |
| MCP declaration to server map | Wework `agent_plugins`; Backend `plugin_package_parser` |
| Server map to component index | Wework import preview; Backend package parser           |
| Server map to Claude / Kimi   | Wework `agent_plugins` Claude adapter                   |
| Server map to OpenCode        | Wework `agent_plugins` OpenCode adapter                 |
| Source plugin to Codex        | Codex personal-marketplace installation path            |
| Manual MCP JSON to form       | Wework `mcp-json-import`                                |

Invariants:

- `.mcp.json` accepts the Codex-standard direct server map and `mcp_servers` wrapper. `mcpServers` remains only for compatibility with existing Claude/Wework plugins. Preview, component counting, Backend indexing, and Harness adapters use the same parsing semantics.
- A manifest MCP path is a safe relative path contained by the plugin root. Format compatibility never weakens path validation.
- The Codex plugin package is installed unchanged. Cross-Harness differences exist only in derived adapters and never rewrite `.mcp.json`.
- A server containing `command` normalizes to local stdio. A server containing `url` normalizes to a remote transport. A Codex configuration with only `url` is not dropped because it omits an explicit `type`.
- Remote static headers accept both Codex `http_headers` and Claude/OpenCode `headers`. When both exist, `http_headers` is read first and `headers` overrides duplicate names, preserving existing Wework behavior.
- Claude and Kimi Streamable HTTP output uses `type: http` and `headers`; OpenCode output uses `type: remote` and `headers`. Derived adapters never leave unsupported `http_headers` in the target configuration.
- Format errors appear as explicit validation issues before installation. An invalid declaration is never silently reported as zero MCP servers.
