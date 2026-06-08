---
sidebar_position: 1
---

# Overview

Resource Library is used to publish, discover, and accept reusable resources. The Discover page helps users find shared team resources, review how to use them, and accept them into their own resource list.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| Discover | Resource discovery page for browsing published resource descriptions by goal and use case |
| Mine | Resources the current user can use or manage |
| Publish | Publish one of your Agents or Skills as a resource description |
| Accept | Accept the publisher's share so the resource appears in your resource list |
| Discover Assistant | Agent that helps users search and choose resources through chat |

Resource Library displays resource descriptions and does not copy the publisher's Agent or Skill. When the publisher edits the original resource, users who accepted it see the latest shared behavior.

---

## Using Discover

1. Open **More** → **Resource Library** from the sidebar.
2. The page opens on the **Discover** tab by default.
3. Enter a goal, scenario, or keyword in the search box.
4. Use the type badge on each card to see whether the resource is backed by an Agent or a Skill.
5. Click the usage button on a resource card to open its mini usage guide.
6. Review the resource description and getting-started steps, then accept the resource.

After accepting a resource, the action button shows that it has been accepted. The resource appears under the matching type on the **Mine** tab.

---

## Using Discover Assistant

Discover Assistant is a real Wegent Agent, not a static frontend search. It uses the existing knowledge-base retrieval tools to query the organization Resource Library knowledge base, then recommends resources from the currently discoverable resource descriptions.

Useful prompts include:

- "Is there an Agent for weekly reports?"
- "I want to do code review. Which resource should I use?"
- "Find a Skill that can help process knowledge-base documents."

If Discover Assistant says it cannot find resources, the organization Resource Library knowledge base may be missing, synchronization may still be pending, or the keywords may not match the published descriptions.

---

## Publishing Resources

On the **Mine** tab, resource owners can publish resources from the Agent or Skill list:

1. Find the Agent or Skill to publish.
2. Click the publish button.
3. Fill in the display name, description, tags, and version.
4. Submit the form. The resource appears on the Discover page.

When a resource is published, updated, or archived, the system synchronizes its display description into the organization Resource Library knowledge base so Discover and Discover Assistant can search it.

---

## Managing My Resources

The **Mine** tab keeps a management-style layout for scanning and maintaining resources. You can filter by:

- Resource type, such as Agent, Skill, Model, Shell, or Retriever
- Source, such as created by me, team, system, or resource library
- Agent mode, such as chat, coding, or device

Skills or Agents from Resource Library are not automatically enabled by default. Enable them manually from the corresponding resource management page when needed.

---

## Admin Configuration

The Discover page is driven by the `ResourceLibraryDiscoveryConfig` Kind. Administrators should prepare an organization-level knowledge base, commonly named `资源库`, and configure the Discover Assistant Team.

See [YAML Configuration Formats](../../reference/yaml-specification.md#-resourcelibrarydiscoveryconfig) for the YAML fields.
