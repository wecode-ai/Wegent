---
sidebar_position: 90
---

# Streaming block index

Python and Rust share the `chat:streaming:blocks:{subtask_id}` list and its derived
`chat:streaming:blocks_index:{subtask_id}` hash. Every business field is encoded as
`block:{complete business ID}`. Metadata uses `_watermark` and `_watermark_id`.
Business IDs have no reserved words: `_watermark_id`, `_watermark`, and `block:a`
are all valid IDs.

Appends record the position returned by `RPUSH`. Hits read a single block; misses
index the suffix after the watermark, supporting legacy lists and appends from
other writers. Invalid positions or watermark boundaries rebuild the index.
The index and list have the same one-hour TTL and are cleaned up together. Rust
lookups and atomic offset-based text appends reuse the same Lua lookup function.

The index reduces whole-list transfers and JSON parsing. Redis `LINDEX` and
`LSET` still have linear cost for middle positions; arbitrary historical updates
are not guaranteed to be O(1).

The minimum verified server version is Redis 4.0.11. Lease acceptance reads the
remaining `PTTL` and updates the token with `SET XX PX` in the same Lua script,
preserving the original expiry without Redis 6's `KEEPTTL`. Expired-lease and
stale-owner checks remain enforced.

## Acceptance user story

As a user, I want a long agent run to keep updating tool results, preserve the
order of text and reasoning, and retain complete content after streaming ends.

| Scenario | Required assertion | CI suite |
| --- | --- | --- |
| Repeated updates with special IDs | Update the original position without changing count or order | Python unit, real Redis integration, Rust Redis integration |
| Shared Python/Rust index and unindexed legacy appends | Repair missing entries and update blocks far from the tail without duplicates | Python/Rust Redis integration |
| Index expiration and cleanup | Rebuild from the source list after expiration; delete the index with the list | Python/Rust Redis integration |
| Long streaming HTTP callbacks | Alternate tools, reasoning, and text for 40 rounds, update special IDs, and preserve final MySQL content, order, and statuses | `responses_large_json` HTTP E2E |

Tests reuse the existing CI MySQL, Redis, and Responses HTTP fixtures, without
adding CI services or shards.
