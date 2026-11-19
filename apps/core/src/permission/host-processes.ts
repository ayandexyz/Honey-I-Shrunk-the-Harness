// =============================================================================
// Host processes — this process and every ancestor up to init: the daemon
// itself, the app or terminal that started it, and whatever started that. The
// self-kill guard (self-kill.ts) refuses commands aimed at any of them.
//
// Linux reads /proc. Elsewhere only this process and its parent are known (no
// /proc to walk), which still covers the common case: the desktop app or the
// shell that spawned the daemon.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { HostProcess } from "./self-kill.js";

/** Bound on the walk; a real chain is under ten deep. */
const MAX_DEPTH = 32;

function readProc(pid: number): (HostProcess & { ppid: number }) | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid pgrp …` — comm may itself contain spaces and
    // parentheses, so split on the LAST ")".
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const [, ppid, pgid] = stat.slice(close + 2).split(" ");
    let cmdline = "";
    try {
      cmdline = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .join(" ")
        .trim();
    } catch {
      // Unreadable cmdline (another user's process): comm is still known.
    }
    return { pid, pgid: Number(pgid), comm, cmdline, ppid: Number(ppid) };
  } catch {
    return undefined;
  }
}

export function hostProcesses(): HostProcess[] {
  if (process.platform !== "linux") {
    return [
      {
        pid: process.pid,
        comm: path.basename(process.execPath),
        cmdline: process.argv.join(" "),
      },
      { pid: process.ppid, comm: "", cmdline: "" },
    ];
  }
  const chain: HostProcess[] = [];
  let pid = process.pid;
  // pid 1 (init / systemd) is not ours to protect: killing it is refused by
  // the kernel for a normal user anyway.
  while (pid > 1 && chain.length < MAX_DEPTH) {
    const proc = readProc(pid);
    if (!proc) break;
    const { ppid, ...host } = proc;
    chain.push(host);
    pid = ppid;
  }
  return chain;
}
