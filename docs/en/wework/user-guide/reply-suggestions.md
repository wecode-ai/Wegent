---
sidebar_position: 20
---

# Reply suggestions

**Predict next reply** is enabled by default. Turn it off or back on in **Settings → General → AI assistance**. A saved preference to disable predictions is preserved. Predictions inherit the current Codex conversation model; there is no separate prediction model selector.

After an AI response completes in a task, temporary chat, or project activity conversation, the empty composer may display a gray suggestion. Press **Tab, Right Arrow, or Enter** to accept it as an editable draft. This key press only accepts the suggestion. Review the text, then send it using your normal send shortcut. You can edit, undo, or ignore the suggestion and type your own reply.

Suggestions are hidden when there is a draft, attachment, reference, autocomplete menu, input method composition, running conversation, or pending interaction. The model may return no suggestion. Failed, timed-out, or unavailable predictions do not block normal chat.

Prediction results for the same turn and model configuration are saved locally and reused after refreshing, restarting, or reopening a task without another model request. Empty results, failures, and acceptance are also retained. A new completed turn or changed model configuration allows another prediction. Each task stores only its latest result. Archiving preserves it; successful permanent deletion removes it. Bulk deletion clears results only for tasks confirmed deleted.

Predictions use the current conversation model's allowance. Wework forks an ephemeral Codex prediction thread, inheriting the original history, effective configuration, instructions, and tool definitions. It adds a prediction prompt and requests low reasoning effort. The prompt instructs the model not to call tools or perform actions; predictions are not added to the original conversation history. Starting another turn, disabling the feature, or leaving the last composer using that conversation cancels pending predictions. New conversations without a completed Codex turn do not generate suggestions.

Preserving the original prompt prefix helps reuse the model service's cache, but cache hits and fees depend on the provider. Predictions still make model requests and are not guaranteed to be free or always cheaper than short-context requests. Wework bundles Codex 0.163.0-alpha.5 to support the prediction fork protocol.

While generating, the composer toolbar shows a small “Generating a suggestion…” status. Typing hides it; completion, cancellation, or failure removes it.

Predictions use fresh authentication for the conversation's selected model without saving credentials in task history. Failed or timed-out requests display a message below the composer asking you to check the current model's connection and authentication settings. Normal chat remains available. After fixing the settings and completing another turn, predictions run again. A model returning no suggestion does not show an error.

When a suggestion appears, click “Accept suggestion · Tab” or press Tab, Right Arrow, or Enter to insert it as a draft, then edit and send.

In Wework, `/model` and the model button open the same selector. Suggestions stay hidden while this menu is open and return when it closes, preventing acceptance keys from conflicting with menu navigation.
