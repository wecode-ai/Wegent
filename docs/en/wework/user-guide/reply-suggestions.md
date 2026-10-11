---
sidebar_position: 20
---

# Reply suggestions

Choose a configured model in **Settings → Models → Reply suggestions**. Selecting a model for the first time enables predictions. This model is independent of the conversation model. Without a selection, predictions stay disabled and no other model is used automatically. You can turn the feature off at any time.

After an AI response completes in a task, temporary chat, or project activity conversation, the empty composer may display a gray suggestion. Press **Tab, Right Arrow, or Enter** to accept it as an editable draft. This key press only accepts the suggestion. Review the text, then send it using your normal send shortcut. You can edit, undo, or ignore the suggestion and type your own reply.

Suggestions are hidden when there is a draft, attachment, reference, autocomplete menu, input method composition, running conversation, or pending interaction. The model may return no suggestion. Failed, timed-out, or unavailable predictions do not block normal chat. Returning to a conversation reuses the cached result for that turn during the current app session.

Predictions use the separate model's allowance and send it the conversation goal and recent context. Generation runs in a temporary conversation with tools disabled, performs no task actions, and does not enter the real conversation history. Starting another turn, disabling the feature, or changing prediction models cancels previous predictions.
