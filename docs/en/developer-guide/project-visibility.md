---
sidebar_position: 35
---

# Project visibility and workspace navigation

Visible projects are the union of the following sets, excluding archived projects:

- Public projects.
- Projects configured as Related tasks only.
- Projects with a direct membership for the current user.
- Projects in active workspaces the current user actually belongs to.

Creators retain Owner access. Workspace membership provides the baseline Reporter project role, without project administration. Stronger explicit project roles take precedence. Reporter actions follow the existing project permission rules. Pending, rejected, and invalid-role memberships do not grant access.

Related tasks only is available only for the built-in task source. It lets every signed-in user discover and enter the project without exposing the full issue set to ordinary visitors. Owners and Maintainers can read every issue. Other users can read only issues they created, are assigned to, collaborate on, have an active task binding for, or that are assigned to a robot they created. Issue lists, details, deliveries, execution records, project conversations, and My Work reuse the same relevance check. Reading an unrelated issue returns not found so its existence is not disclosed.

```mermaid
flowchart LR
    A[Public or Related tasks only projects] --> D[Merge project IDs and effective roles]
    B[Project memberships] --> D
    C[Workspace memberships] --> E[Workspace project grants]
    E --> D
    D --> F[Project listing and detail authorization]
    D --> G[Batch minimal parent workspace metadata]
    G --> H[Sidebar workspace groups]
```

Project listing and individual authorization share `cloud_project_visibility.py`. Nonempty project lists resolve permissions and parent contexts in two queries. Single-project authorization pushes the project ID into each grant branch. Nonempty workspace lists batch roles and aggregate counts in three queries.

The project response's `workspace_context` contains only the parent's ID, public ID, and name. Displaying a parent label through a project neither creates workspace membership nor grants access to workspace settings, members, or unrelated private projects. Empty workspaces the user belongs to remain visible.

The sidebar merges workspace memberships with project parent contexts and builds a Map of projects by workspace in one pass. Opening a project reuses its parent context from the response.

This implementation changes neither the database schema nor indexes and introduces no authorization cache. Access levels remain in JSON; the scan cost for Public and Related tasks only projects requires a MySQL execution-plan check. Lists retain the existing unpaginated response contract. A fixed query count does not imply a bounded response size.
