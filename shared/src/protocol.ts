// The contract between the JARVIS server and JARVIS Desk (docs/TDD.md → Desk API).
// Both sides import from here; changing it means updating both in the same PR.

/** Bumped whenever the Desk API changes in a way an older Desk can't handle. */
export const PROTOCOL_VERSION = 1;
