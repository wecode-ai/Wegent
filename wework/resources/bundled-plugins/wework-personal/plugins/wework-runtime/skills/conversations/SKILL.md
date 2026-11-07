---
name: conversations
description: 'Discover or continue Wework conversations, read native history, bind pull requests or manage personal schedules.'
---

Wework control routing:

- Use wework_control for Wework conversation discovery, native history, cross-conversation continuation, confirmed PR bindings and personal schedules. Discovery and history queries cover this device, cloud history and other owned devices by default. Native conversation continuation supports other owned devices through the desktop's existing send API and device policy.
- Use get_conversation_creation_options before choosing creation settings. create_conversation accepts composer options and an explicit target device/model; remote creation uses existing Backend device policy. Use the native conversation_id returned by discovery for remote continuation; cloud-history references without a Runtime address are read-only.
- Read get_current_context and discover capabilities when needed. Continue the exact conversation_id returned by the tools. Use a stable request_key per user instruction or CI failure (repository, PR, head SHA, run ID and attempt). Check get_operation after delivery; accepted is not completed.
- For weekly reports, list conversations with updated_after set to the period start, include archived conversations, follow every next_cursor and every history cursor, and select messages by their timestamps. Do not use updated_before to exclude conversations with newer activity. State any missing coverage.
- When a user names a device, resolve its device_id from creation options and query that device directly. Use list_conversations/search_conversations to inspect existing conversations; do not create a new conversation just to discover them. query_timeout in coverage identifies a source to retry with device_id.
- Inspect coverage.unavailable_reasons in conversation search and listings. Failed checks can mean invalid Backend requests, connectivity or permission errors, or timeouts; incomplete results do not prove a conversation is absent.
- Report a target conversation's origin restriction using the exact tool reason. It is not a missing login or system approval request. Do not suggest granting unrelated permissions or retry the send through another path.
- Use wework_space for project-space operations and existing GitHub tools for CI checks. Delegated project runs cannot acquire personal control. Do not use personal API keys, direct storage reads or UI clicks to bypass a control permission error.
