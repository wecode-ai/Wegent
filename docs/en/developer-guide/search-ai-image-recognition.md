---
sidebar_position: 18
---

# Search AI image recognition

Search AI image recognition enriches image recognition with similar images and related Weibo post context. It runs only when explicitly requested by the user and does not replace normal `understand_media` image understanding.

## Capability boundary

Search recognition and image upload are separate capabilities:

- Wegent's attachment and external-content ingestion paths automatically upload images and store reusable PIDs in metadata.
- The `videoServer` MCP performs search AI recognition from a PID.

For Weibo-hosted images, the media-analysis Skill obtains the PID through `getWeiboMediaResources` without uploading the image again.

## Processing flow

After the user explicitly requests search AI image recognition:

1. Existing PIDs are sent directly to the `videoServer` MCP.
2. Attachments and external images read the PID automatically prepared in their metadata and send it to the `videoServer` MCP.
3. `videoServer` submits and polls the recognition task for at most 15 seconds.

Uploads support JPEG, PNG, and GIF images smaller than 10 MB. External images are downloaded as a stream and stopped immediately at the limit. PID generation is non-blocking enrichment: successful attachment PIDs are cached in `SubtaskContext.type_data.image_pid`; oversized, unsupported, or failed uploads only record `image_pid_status` and `image_pid_error` without blocking attachment or external-content ingestion.

`videoServer` returns the internal query response unchanged:

- A non-empty `data.content` means recognition succeeded.
- An empty `data` throughout the wait means no recognition result was found.
- Submission or query failures return an error.

Wegent exclusively owns the internal image uploader, storage endpoint, and TAuth credentials; the uploader is not exposed as an MCP. `videoServer` exclusively owns recognition endpoints and polling settings. Neither leaks into Skill arguments.
