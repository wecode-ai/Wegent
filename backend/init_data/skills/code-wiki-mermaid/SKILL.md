---
description: "Create source-grounded Mermaid diagrams for Code Wiki pages when system relationships are clearer visually than as prose."
version: "1.0.0"
author: "Wegent Team"
tags: ["code-wiki", "diagram", "mermaid"]
bindShells: ["ClaudeCode"]
---

# Code Wiki Mermaid

Diagrams explain relationships; they are not decoration. Use Mermaid when inspected
source supports a relationship that is materially clearer visually:

- `flowchart` for architecture components, data movement and branching control flow;
- `sequenceDiagram` for calls across processes, services or major modules;
- `stateDiagram-v2` for lifecycles and state machines;
- `erDiagram` for important persisted entities and their relationships.

Skip navigation, configuration reference and other pages where a diagram adds no
explanatory value. Do not target a diagram count.

## Evidence and scope

- Every participant, state, entity and relationship must come from source, tests or
  supporting history you inspected. Do not infer a complete architecture from names.
- Keep one diagram focused on one relationship or workflow. Split diagrams that need
  long labels or too many nodes to remain readable.
- Give the diagram a one-line caption that explains what boundary or flow it shows.
- When an incremental update changes a documented flow, lifecycle or data model, update
  the diagram in the same page. Leave an accurate diagram unchanged.
- Do not embed repository-relative images such as `![x](./docs/x.png)`. Code Wiki does
  not currently have an authenticated repository-image channel; use Mermaid or prose.

## Syntax safety

- Use short alphanumeric node IDs and quote labels containing spaces or punctuation.
- In sequence diagrams, alias participant display names that contain punctuation.
- Do not use Mermaid reserved words such as `end`, `loop`, `alt`, `opt`, `par`, `note`,
  `class` or `state` as node IDs or aliases.
- Keep human explanation in nearby prose instead of long edge or node labels.
- Submit Mermaid as a fenced `mermaid` block. The Code Wiki completion step applies
  limited structural checks and returns page-specific corrections for issues it
  detects. It does not run the Mermaid renderer, so also keep syntax conservative and
  review the published diagram when possible.
