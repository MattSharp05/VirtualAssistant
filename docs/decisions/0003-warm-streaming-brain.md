# 0003 — A warm, streaming brain process
**Context.** Today each message spawns `claude -p` and waits for the full JSON result: 3–7 s before anything appears. Voice needs the first sentence in ~1–2 s.
**Decision.** Keep one `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` process alive per conversation (chat and worker). User turns are written as JSON lines; text deltas, tool_use/tool_result and the final result (usage, duration) are parsed from stdout and published as events. The process restarts on model change, "new conversation", crash, or 30 min idle (then resumes the same session id).
**Alternatives.** Keep per-message processes and only stream output (still pays ~1–2 s startup per turn).
**Consequences.** Metrics come from the result event as today. A flag (`BRAIN_WARM=0`) falls back to the old path if the CLI's stream-json input changes.
