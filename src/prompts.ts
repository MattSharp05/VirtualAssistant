// Text JARVIS sends into cloud sessions. The routine's saved prompt (docs/routine-prompt.md)
// carries the standing rules, including how to report back on Telegram; these only add the
// job handle, the send time (so reports can say how long the work took) and the instruction.

export function newJobText(jobId: string, task: string, sentAt: Date): string {
  return [`JARVIS job: ${jobId}`, `Sent at: ${sentAt.toISOString()}`, "", "Task from Matthew:", task.trim()].join("\n");
}

/**
 * `external` sessions (attached or self-reporting, e.g. orchestrators in other repos) don't have this
 * repo's scripts/report.sh, so they're pointed at the copy in the claude-workflow plugin.
 */
export function followUpText(jobId: string, message: string, sentAt: Date, external = false): string {
  const script = external ? "<workflow plugin>/scripts/jarvis_report.sh" : "scripts/report.sh";
  return [
    `Message from Matthew via JARVIS (job ${jobId}, sent at ${sentAt.toISOString()}):`,
    "",
    message.trim(),
    "",
    `When you've acted on this, report back with ${script} ${jobId} ${sentAt.toISOString()} "<message>".`,
    ...(external
      ? ["If that script or JARVIS_REPORT_URL isn't available here, just answer in this session; Matthew can read it."]
      : []),
  ].join("\n");
}
