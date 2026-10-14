# 0009 — Files: uploads with a restricted Read tool; folders via Desk RPC
**Context.** File drop, screen awareness and folder access, while the container never mounts the Mac's disk.
**Decision.** Uploaded files land in `/data/jarvis/uploads/<id>`; the brain gets the built-in `Read` tool restricted by permission rules to that directory (images and PDFs are read natively by Claude). Folder access: Settings lists allowed folders; the server asks the Mac via an SSE `rpc` event and the Desk returns the file (size cap 2 MB, text/PDF/image only).
**Consequences.** Uploads are deleted after 7 days. Screen awareness = Desk screenshot → upload → Read (needs Screen Recording permission, only on request).
