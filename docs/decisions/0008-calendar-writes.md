# 0008 — Calendar writes without confirmation, with a change log and undo
**Context.** Matthew chose no confirm tap.
**Decision.** Allow the Google Calendar connector's create/update/delete/respond tools. The system prompt requires `get_event` before update/delete and only named guests. The stream parser records each calendar write (tool input + result, and the preceding get_event result) in `calendarLog`, announced in Chat/Telegram/Desk. "Undo" hands the log entry to the brain with an `undo` instruction (re-create, restore fields, or re-RSVP).
**Consequences.** Undo is best-effort through the brain; deleted events also stay in Google's Bin for 30 days.
