---
sidebar_position: 20
---

# Reply suggestions

Enable **Predict next reply** in **Settings → General → AI assistance** to expand model settings. By default, predictions use the current task model. You can also choose a separate model. Turning predictions off hides model settings and preserves the selection. An unavailable model does not generate suggestions.

After an AI response completes in a task, temporary chat, or project activity conversation, the empty composer may display a gray suggestion. Press **Tab, Right Arrow, or Enter** to accept it as an editable draft. This key press only accepts the suggestion. Review the text, then send it using your normal send shortcut. You can edit, undo, or ignore the suggestion and type your own reply.

Suggestions are hidden when there is a draft, attachment, reference, autocomplete menu, input method composition, running conversation, or pending interaction. The model may return no suggestion. Failed, timed-out, or unavailable predictions do not block normal chat. Returning to a conversation reuses the cached result for that turn during the current app session.

Predictions use the selected model's allowance and send it the conversation goal and recent context. Generation runs in a temporary conversation with tools disabled, performs no task actions, and does not enter the real conversation history. Starting another turn, disabling the feature, or changing prediction models cancels previous predictions.

While generating, the composer toolbar shows a small “Generating a suggestion…” status. Typing hides it; completion, cancellation, or failure removes it.

When a suggestion appears, click “Accept suggestion · Tab” or press Tab, Right Arrow, or Enter to insert it as a draft, then edit and send. “Same as task” selects the same model; prediction remains a separate short-context request and does not fork the original conversation or guarantee reuse of its prompt cache.

In Wework, `/model` and the model button open the same selector. Suggestions stay hidden while this menu is open and return when it closes, preventing acceptance keys from conflicting with menu navigation.
