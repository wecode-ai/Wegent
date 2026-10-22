# Codex Plugin Creator validator snapshot

The files under `scripts/` are copied from the `plugin-creator` system skill
bundled with the ChatGPT app used for Codex 0.162.1, with only repository
format-hook normalization. Wework packages this validator with its own Plugin
Creator skill so local and cloud executors enforce the same standard plugin
contract without depending on a pre-populated `CODEX_HOME`.
