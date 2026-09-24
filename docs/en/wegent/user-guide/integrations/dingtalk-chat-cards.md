---
sidebar_position: 3
---

# Optional DingTalk chat cards

Open **Administration → IM channels → Edit DingTalk channel** and enter a Chat AI card template ID. Leaving it empty preserves existing replies. Channels with `use_ai_card=false` still use ordinary replies. The subscription notification `card_template_id` remains independent.

Publish the template for the robot's DingTalk application. Bind the same Markdown field in both writing and completed states; enable streaming on the writing component. The text input accepts text, while a separate Upload Image component supplies optional images. Card file uploads are not integrated yet.

Deploy the complete backend first and wait until all instances are upgraded, then deploy the administration frontend and configure the chat template. Deploying only the backend is also supported: channels without `chat_card` keep their existing replies. Before enabling it broadly, verify streaming output, answer completion, and card follow-ups on a test channel.

## Configuration

Entering only the template ID uses the defaults below. Advanced settings allow different field names and disabling follow-ups.

| Setting | Default | Purpose |
| --- | --- | --- |
| `template_id` | Required only for custom cards | DingTalk template ID |
| `content_key` | `content` | Markdown answer field |
| `follow_up_enabled` | `true` | Accept card follow-ups |
| `follow_up_action` | `follow_up` | Submit button callback action ID |
| `follow_up_text_key` | `followUpText` | Text parameter in the callback |
| `follow_up_images_key` | `followUpImages` | Image URL array parameter in the callback |
| `follow_up_status_key` | `null` (disabled) | Optional send status field bound in the template |
| `initial_data` | `{}` | Optional initial template variables set through the configuration API; values must be strings |

The channel stores settings in `config.chat_card`, for example:

```json
{
  "chat_card": {
    "template_id": "your-template.schema",
    "content_key": "answer",
    "follow_up_action": "ask_again",
    "follow_up_text_key": "question",
    "follow_up_images_key": "photos",
    "follow_up_enabled": true,
    "initial_data": { "heading": "Assistant" }
  }
}
```

Send `{"chat_card": null}` to remove this configuration through the API. Omitting the field leaves it unchanged. Clearing the template ID in the administration form sends `null`.

`flowStatus` is reserved by DingTalk's AI-card protocol and cannot be the content field. DingTalk templates own styling and layout; field mapping does not turn an ordinary card into a streaming AI card.

## Notification cards (optional)

The same DingTalk channel can push its in-app notifications as cards. Turn on "Send task notifications as cards" and mentions, assignments, run starts and run completion/failure/cancellation go out as cards; with the option off, or when the card cannot be delivered, the markdown notification is sent instead. In-app notifications and stored records are unaffected.

By default, DingTalk's built-in Markdown message card needs no custom template. Its variable contract is `title`, `markdown`, `tips`, and `msgButtons` inside `sys_full_json_obj`. The custom template below uses a different contract. Notifications use ordinary message cards, not AI cards with streaming state and feedback controls.

For a layout that separates the notification type, item, detail, and actions, import the [Wegent notification card example](../../../../examples/dingtalk-wework-notification-card.json):

1. In the [DingTalk card platform](https://open-dev.dingtalk.com/fe/card), create an ordinary message card for the robot application that sends notifications. Import the JSON in the editor, review the preview, then save and publish it.
2. Copy the ID of the **new template in your organization**. Turn on "Send task notifications as cards" for the DingTalk channel and enter that ID. The test organization's template ID cannot be reused across organizations.
3. Ensure production `FRONTEND_URL` is a reachable HTTPS address. In a real DingTalk client, check mentions, assignments, each run state, and both actions. The custom card's Wework action opens a Wegent handoff page; the recipient then clicks its desktop action. If the page cannot launch Wework inside DingTalk, open it in a system browser and try again.

The custom template defines these 13 ordinary variables, which the backend fills when delivering a card:

| Variable | Content |
| --- | --- |
| `kindLabel` | Mention, assignment, or run status label |
| `tone` | Status color: `blue`, `orange`, `green`, `red`, or `gray` |
| `headline` | Action headline, such as "Your task is complete" |
| `itemTitle` | Task title |
| `itemKey` | Task key |
| `metaLine` | Board, task status, and assignee summary |
| `detailLabel` | Detail heading, such as "Comment" or "Failure reason" |
| `detail` | Comment, result, or reason; at most 240 characters on the card |
| `showDetail` | Whether to show the detail; defined as a Boolean template variable |
| `primaryLabel` | Web action label, "查看任务" (View task) |
| `primaryUrl` | Task web URL |
| `secondaryLabel` | Desktop action label, "在 Wework 中打开" (Open in Wework) |
| `secondaryUrl` | Wegent web handoff page, which constructs a Wework deep link only from valid board, task, and comment identifiers |

`tone` follows the notification type and state: mentions, assignments, and run starts are `blue`; waits for approval or a device are `orange`; completed is `green`; failed is `red`; cancelled is `gray`. The headline names the action, while the item title, key, context, and optional detail have separate areas. The handoff page also offers a web View task action. Stored in-app notification URLs, built-in cards, and Markdown notifications keep their original `wework://` links. Quotable local run notifications remain text messages so they can be quoted to continue the task.

The configuration lives in the channel's `config.notification_card`. For a custom template:

```json
{
  "notification_card": {
    "template_id": "your-published-template.schema"
  }
}
```

Turning on the option without a custom template ID uses the built-in template. Send `{"notification_card": null}` to turn it off through the API. Omitting the field leaves it unchanged.

## Follow-ups and history

Group quoted replies can use the same follow-up flow. Delivery records map `carrierId` to `outTrackId`; a quoted reply mentioning the bot resolves its `originalProcessQueryKey` through that mapping. Only mapped cards from this bot, in their original group and company, qualify. Ordinary messages, unmatched quotes and slash commands keep their existing routing. The index expires after 7 days and is not automatically available for cards delivered before this change.

Each answer creates a new card and updates that card throughout the round. A follow-up uses the server-owned `outTrackId` mapping to continue the original task with its agent and execution settings. The answer gets a new card; previous answers and the currently selected private IM task remain unchanged.

Bindings and template mapping snapshots live in shared Redis for 7 days. Expired cards require a new @mention. DingTalk group cards enable collaboration by default. A different user in the same company and original group can submit a follow-up to convert the existing task into a Wegent group chat and join it. Each contribution records its actual sender; members can access the same task and full history in Wegent. The task owner remains unchanged. This does not create a DingTalk group or change joining rules for other channels. Removed members cannot rejoin through a card.

Collaboration requires staff ID or email mapping to distinct Wegent accounts. The selected-user mapping cannot represent other participants. Private cards and device-local runtime tasks remain restricted to the original sender. Running tasks and concurrent card submissions are rejected; Stream retries are deduplicated by event ID.

The backend registers `/v1.0/card/instances/callback` on the robot's existing Stream connection and uses its application credentials. No second Stream client is needed. Callback parameters supply text and optional images, never the target task.

Before acknowledging an action, the backend atomically stores its pending receipt and deduplication marker in Redis. Each channel recovers pending receipts periodically. Actions interrupted after processing started are reported as uncertain instead of automatically executing the AI turn again. Leases renew every 30 seconds and expire within approximately 90 seconds after a process exits. Outstanding receipts remain until settled; terminal deduplication records last 7 days. Recovery depends on Redis retaining its data: do not treat this instance as a disposable cache.

Card updates retry transport errors, HTTP 429 and 5xx responses up to 3 attempts using the same content and guid. Failed final delivery propagates the error and retains the callback and shared answer until their existing TTL, allowing subsequent redelivery to retry. Local task events must match the originating message and channel IDs to update a custom card.

## Optional send feedback

1. Create a plain text template variable `followUpStatus`, initially `idle`.
2. Set the channel's advanced Send status field to `followUpStatus`.
3. Bind the button label and state: `sending` means Sending and disabled, `sent` means Sent, `failed` means Retry, and `idle` means Send. Disable only while `sending`.
4. If the template supports a loading animation, show it when the variable equals `sending`. Save and publish the template, then verify on a new card.

The backend updates only this field, preserving the answer and entered text/images. `sent` means the submission handler returned successfully, not necessarily that the model has finished answering. This field is independent of `flowStatus`. Leaving it unset preserves existing behavior. Button bindings and animations require configuration in the DingTalk template editor; channel configuration does not change the layout.

Update protocol reference: [official DingTalk Python SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-python/blob/main/dingtalk_stream/card_replier.py).

## Image follow-ups

With default field mappings, configure the DingTalk card editor as follows:

1. Create the local variable `followUpImages` as an array of plain text, initially `[]`.
2. Select Upload Image, then Events → Update Local Variable → `followUpImages`.
3. On the submit button, keep `followUpText` and add `followUpImages`. Select Variable as its type and the local variable `followUpImages` as its value.
4. Save and publish the template, then test a new card. Update the channel's advanced mappings when using custom field names.

The callback's `cardPrivateData.params` should have the following shape. Omit the image field or send `[]` for text-only follow-ups:

```json
{
  "followUpText": "Explain this image",
  "followUpImages": ["https://static.dingtalk.com/media/example.png"]
}
```

Text, text with images, and images alone are supported. Image-only messages use “请查看图片” as the prompt. Ordinary @mentions exchange a download code for an image URL; the card upload component supplies URLs directly. Both reuse the existing attachment service after downloading: cloud tasks link attachments to the current user message, and local tasks receive `attachment_ids`.

URL validation accepts `https://static.dingtalk.com/media/` and `https://down.dingtalk.com/ddmedia/` without following redirects. Desktop uploads using the `static` address have passed download verification. Mobile uploads using the `down` address return `403 / cookie_empty` to the current server request without cookies; download authentication remains unresolved, so mobile image support is not complete. Supported formats are PNG, JPEG, GIF, and WebP, with at most 9 images, 10 MB per image and 30 MB total. Download or persistence failure reports an error and prevents this round from triggering the model with missing images.

The `image_count` in `card_follow_up_accepted` records received images; `attachment_ids` in `card_follow_up_images_persisted` identifies saved attachments. A successful client upload alone does not prove the submit button included the image variable.

## Live verification

1. Configure one test channel and @mention its robot. Confirm text grows before completion.
2. Submit a follow-up. Confirm a new card appears in the original conversation and the same Wegent task retains its history.
3. Switch the current conversation, then submit from an older card. Confirm it still targets that card's original task.
4. Check another account, duplicate events, and submissions during execution do not cause unauthorized or duplicate execution.
5. Clear the chat template and confirm existing replies resume while notification templates remain unchanged.
6. Test text only, text with images, and images only. Confirm attachments on the current Wegent message; a download failure must report an error without generating a response with missing images.

Local unit tests mock DingTalk HTTP, task services, and cache to verify protocol and routing. Client rendering and actual button callbacks still require live verification.

Protocol references: [DingTalk Stream event types](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/protocol/), [card action callbacks](https://dingtalk.apifox.cn/doc-3595405).
