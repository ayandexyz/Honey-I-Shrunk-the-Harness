// =============================================================================
// Self-kill guard — refuse a shell command that would kill the process this
// session runs in, or anything above it (the desktop app, the terminal).
//
// Session baddd7f8 (MiniMax-M3, danger mode) ran `kill 196692` on the Honey
// desktop window that hosted it, to swap in a dev build. The app, the daemon
// and the agent died mid-step; the dev build it meant to start never ran.
// Killing your own host is never the user's intent and cannot be recovered
// from inside the session, so this holds in EVERY mode, danger included —
// it runs before the permission pipeline, not inside it.
//
// Covers the spellings a model reaches for: `kill <pid>`, `kill -- -<pgid>`,
// `kill -1`, `pkill [-f] <pattern>`, `killall <name>`, and a kill fed by
// `pgrep`/`pidof` (`kill $(pgrep honey)`, `pgrep -f x | xargs kill`).
// Not a sandbox: a script, an alias or `eval` defeats it.
// =============================================================================

import { commandSegments } from "../utils/shell-segments.js";

export interface HostProcess {
  pid: number;
  pgid?: number;
  /** Kernel process name (/proc/<pid>/comm, ≤15 chars). */
  comm: string;
  /** Full command line, arguments space-joined. */
  cmdline: string;
}

const KILL_VERBS = new Set(["kill", "pkill", "killall"]);
const MENTIONS = /\b(kill|pkill|killall|pgrep|pidof)\b/;

/** Wrappers whose own flags come before the real verb. */
const WRAPPERS = new Set(["sudo", "doas", "nohup", "setsid", "command", "exec", "nice", "timeout", "xargs"]);
/** Wrapper flags that take a value (`timeout -s KILL`, `xargs -n 1`, `nice -n 5`). */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-s", "-k", "-n", "-I", "-P", "-L", "-d", "-a", "-E"]);
/** pkill / pgrep flags that take a value. */
const PGREP_VALUE_FLAGS = new Set(["-u", "-U", "-g", "-G", "-P", "-s", "-t", "-F", "--signal", "--pidfile", "--euid", "--uid", "--pgroup", "--group", "--parent", "--session", "--terminal"]);
/** killall / pidof flags that take a value. */
const KILLALL_VALUE_FLAGS = new Set(["-s", "--signal", "-u", "--user", "-o", "--older-than", "-y", "--younger-than", "-n", "--ns", "-Z", "--context"]);

const unquote = (token: string) => token.replace(/^['"]|['"]$/g, "");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The verb and its arguments, with wrappers stripped. */
function words(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean).map(unquote);
  while (tokens.length > 0 && WRAPPERS.has(basename(tokens[0]))) {
    const wrapper = basename(tokens.shift()!);
    while (tokens[0]?.startsWith("-")) {
      const flag = tokens.shift()!;
      if (WRAPPER_VALUE_FLAGS.has(flag)) tokens.shift();
    }
    if (wrapper === "timeout") tokens.shift(); // the duration
  }
  if (tokens.length > 0) tokens[0] = basename(tokens[0]);
  return tokens;
}

/** Positional arguments, skipping flags and the values they take. */
function positionals(args: string[], valueFlags: Set<string>): { names: string[]; flags: string[] } {
  const names: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      flags.push(arg);
      if (valueFlags.has(arg)) i++;
    } else names.push(arg);
  }
  return { names, flags };
}

/** PIDs named by `kill` arguments; negative = process group. */
function killPids(args: string[]): number[] {
  const pids: number[] = [];
  let signalSeen = false;
  let onlyPids = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!onlyPids && arg === "--") onlyPids = true;
    else if (!onlyPids && (arg === "-s" || arg === "-n")) {
      i++;
      signalSeen = true;
    } else if (!onlyPids && arg.startsWith("-") && !signalSeen && pids.length === 0) {
      signalSeen = true; // -9, -KILL, -SIGTERM
    } else if (/^-?\d+$/.test(arg)) pids.push(Number(arg));
  }
  return pids;
}

const hasFlag = (flags: string[], short: string, long: string) =>
  flags.some((f) => f === long || (/^-[a-z]+$/.test(f) && f.includes(short)));

function regexMatch(pattern: string, text: string, exact: boolean, ignoreCase: boolean): boolean {
  try {
    return new RegExp(exact ? `^(?:${pattern})$` : pattern, ignoreCase ? "i" : "").test(text);
  } catch {
    return text.includes(pattern);
  }
}

/** The host process a pgrep-style pattern selects, if any. */
function patternHit(args: string[], host: HostProcess[]): HostProcess | undefined {
  const { names, flags } = positionals(args, PGREP_VALUE_FLAGS);
  const pattern = names.at(-1);
  if (pattern === undefined) return undefined;
  const full = hasFlag(flags, "f", "--full");
  const exact = hasFlag(flags, "x", "--exact");
  const ignoreCase = hasFlag(flags, "i", "--ignore-case");
  return host.find((p) => regexMatch(pattern, full ? p.cmdline : p.comm, exact, ignoreCase));
}

/** The host process a killall/pidof name selects, if any. */
function nameHit(args: string[], host: HostProcess[]): HostProcess | undefined {
  const { names, flags } = positionals(args, KILLALL_VALUE_FLAGS);
  const regex = hasFlag(flags, "r", "--regex");
  return host.find((p) => {
    const argv0 = p.cmdline.split(" ")[0] ?? "";
    return names.some((name) =>
      regex
        ? regexMatch(name, p.comm, false, false)
        : name === p.comm || name === basename(argv0) || name === argv0,
    );
  });
}

function describe(p: HostProcess, host: HostProcess[]): string {
  const name = p.comm || "process";
  return p === host[0]
    ? `${name} (pid ${p.pid}), this session's own process`
    : `${name} (pid ${p.pid}), which this session runs inside`;
}

/**
 * Why `command` would kill this session's own process tree, or undefined.
 * `host` is read only when the command mentions a kill or pid-lookup verb.
 */
export function findSelfKill(command: unknown, host: () => HostProcess[]): string | undefined {
  if (typeof command !== "string" || !MENTIONS.test(command)) return undefined;
  const segments = commandSegments(command).map(words);
  const procs = host();
  const kills = segments.some((w) => KILL_VERBS.has(w[0]));
  for (const [verb, ...args] of segments) {
    let hit: HostProcess | undefined;
    if (verb === "kill") {
      const pids = killPids(args);
      if (pids.includes(-1)) return "`kill -1` signals every process you own, including this session";
      hit = procs.find((p) => pids.includes(p.pid) || (p.pgid !== undefined && pids.includes(-p.pgid)));
    } else if (verb === "pkill") hit = patternHit(args, procs);
    else if (verb === "killall") hit = nameHit(args, procs);
    else if (verb === "pgrep" && kills) hit = patternHit(args, procs);
    else if (verb === "pidof" && kills) hit = nameHit(args, procs);
    if (hit) return `it would kill ${describe(hit, procs)}`;
  }
  return undefined;
}
