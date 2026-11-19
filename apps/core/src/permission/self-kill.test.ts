import test from "node:test";
import assert from "node:assert/strict";
import { findSelfKill, type HostProcess } from "./self-kill.js";
import { hostProcesses } from "./host-processes.js";

// The chain from session baddd7f8: daemon → daemon launcher → desktop app.
const HOST: HostProcess[] = [
  { pid: 196763, pgid: 196692, comm: "freecode", cmdline: "/home/u/.local/opt/honey/0.6.18/freecode serve" },
  { pid: 196728, pgid: 196692, comm: "freecode", cmdline: "/home/u/.local/opt/honey/0.6.18/freecode serve" },
  { pid: 196692, pgid: 196692, comm: "honey-desktop", cmdline: "/home/u/.local/opt/honey/0.6.18/honey-desktop --restore-state=x.json" },
];
const host = () => HOST;
const refused = (command: string) => findSelfKill(command, host) !== undefined;

test("refuses the command session baddd7f8 ran on its own desktop app", () => {
  const reason = findSelfKill(
    'kill 196692 2>&1; sleep 4; ps aux | grep honey-desktop | grep -v grep | head -3; echo "--- stopped"',
    host,
  );
  assert.match(reason ?? "", /honey-desktop \(pid 196692\), which this session runs inside/);
});

test("refuses kill by pid, signal, group and wrapper spellings", () => {
  for (const command of [
    "kill -9 196763",
    "kill -s TERM 196692",
    "kill -KILL 196728",
    "kill -- -196692",
    "sudo kill 196692",
    "/usr/bin/kill 196692",
    "timeout 5 kill 196692",
    "kill -9 -1",
  ]) {
    assert.ok(refused(command), command);
  }
});

test("refuses pkill, killall and pid lookups that select a host process", () => {
  for (const command of [
    "pkill honey-desktop",
    "pkill -f 'opt/honey/0.6.18/freecode serve'",
    "pkill -9 -f honey",
    "killall honey-desktop",
    "kill $(pgrep honey-desktop)",
    "kill `pidof honey-desktop`",
    "pgrep -f honey-desktop | xargs kill",
    "pgrep -f honey | xargs -n 1 kill -9",
  ]) {
    assert.ok(refused(command), command);
  }
});

test("allows kills aimed elsewhere and commands that only mention kill", () => {
  for (const command of [
    "kill 12345",
    "kill -1 12345", // -1 here is SIGHUP, not "every process"
    "kill %1",
    "pkill -f target/debug/honey-desktop", // a dev build, not the host
    "killall cargo",
    "pgrep -f honey-desktop", // looking is fine
    "grep -rn kill src/",
    "cargo test kill_switch",
  ]) {
    assert.equal(findSelfKill(command, host), undefined, command);
  }
});

test("reads the host list only when the command mentions a kill verb", () => {
  let reads = 0;
  findSelfKill("cargo build", () => (reads++, HOST));
  assert.equal(reads, 0);
  findSelfKill("kill 1", () => (reads++, HOST));
  assert.equal(reads, 1);
});

test("hostProcesses starts at this process and walks up to its parent", () => {
  const chain = hostProcesses();
  assert.equal(chain[0]?.pid, process.pid);
  assert.equal(chain[1]?.pid, process.ppid);
  assert.ok(findSelfKill(`kill ${process.pid}`, hostProcesses));
});
