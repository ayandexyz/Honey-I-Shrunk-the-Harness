/**
 * Remove a completed run's live progress row synchronously and report the
 * elapsed time captured at that transition. The caller can then render the
 * final duration and token totals in a settled transcript row.
 */
export function finishWorkingState(
  removeMessage: (id: number) => unknown,
  messageId: number,
  startedAt: number,
  now = Date.now(),
): number {
  removeMessage(messageId);
  return Math.max(0, now - startedAt);
}
