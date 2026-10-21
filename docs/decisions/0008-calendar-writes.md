# 0008 — Calendar writes without confirmation, with a change log and undo
**Context.** Matthew chose no confirm tap.
**Decision.** Allow calendar writes without a confirm tap; only named guests get added. Every write is recorded (what changed, and a snapshot of before) in `calendarLog`, announced in Chat/Telegram/Desk. "Undo" reverses the logged change (re-create, restore fields, or re-RSVP).
**Consequences.** Deleted events also stay in Google's Bin for 30 days.

**Superseded in part by 0013**: the original implementation here reached the calendar through the claude.ai Google Calendar connector (create/update/delete/respond tools, with the brain calling `get_event` first and the stream parser sniffing its tool calls for the change log). The connector's write tools proved unreliable, so JD-77 replaced that path with a first-party client; undo is now performed deterministically by the tool itself rather than handed to the brain as instructions. The no-confirm-tap decision and the change-log/undo *idea* above still hold — only the transport and how undo is carried out changed.
