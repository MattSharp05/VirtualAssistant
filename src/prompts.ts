// Text JARVIS sends into cloud sessions. The routine's saved prompt (docs/routine-prompt.md)
// carries the standing rules, including how to report back on Telegram; these only add the
// job handle, the send time (so reports can say how long the work took) and the instruction.

export function newJobText(jobId: string, task: string, sentAt: Date): string {
  return [`JARVIS job: ${jobId}`, `Sent at: ${sentAt.toISOString()}`, "", "Task from Matthew:", task.trim()].join("\n");
}

export function followUpText(jobId: string, message: string, sentAt: Date): string {
  return [
    `Message from Matthew via JARVIS (job ${jobId}, sent at ${sentAt.toISOString()}):`,
    "",
    message.trim(),
    "",
    `When you've acted on this, report back with scripts/report.sh ${jobId} ${sentAt.toISOString()} "<message>".`,
  ].join("\n");
}
