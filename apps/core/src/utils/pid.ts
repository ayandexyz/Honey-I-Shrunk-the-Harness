/**
 * Whether the process with this pid is still alive.
 *
 * `kill(pid, 0)` tests existence without signalling. The pid could have been
 * recycled onto an unrelated process, which would read as "still running" —
 * accepted: the alternative is a liveness handshake.
 */
export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
