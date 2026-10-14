# 0007 — A separate worker brain for background jobs
**Context.** Today digest, calendar ranges and task suggestions need the claude.ai connectors, which are only reachable through the CLI.
**Decision.** A second warm brain conversation ("worker") with its own system prompt and a structured-output tool (`submit_digest`, `submit_events`, `suggest_task`) runs scheduled jobs: digest every 30 min (07:00–22:00 local) and on demand, calendar range on window open (cached 10 min), suggestions every 30 min. Its usage is shown separately in the System window. Suggestions from session reports and Notion QA are made without the LLM.
**Consequences.** Background plan usage (estimate a few % of the 5-hour window per day; measured in the System window). Jobs pause when the plan is above 90%.
