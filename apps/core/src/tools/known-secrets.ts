// =============================================================================
// Known-secret redaction for tool output
// Cuts the credentials freecode itself holds out of every tool result before
// it is stored, shown to the model, written to the rollout log or streamed to
// a frontend (called once, in the orchestrator).
//
// Session 8b4b7a32 ran `cat ~/.freecode/config.json` while answering a
// question, which put the MiniMax key into the conversation, the session store
// and every later request. A permission rule would not have stopped it: the
// session was in danger mode, which allows everything (as Claude Code's bypass
// mode does). A pattern scrub (memory/graph/secret-filter.ts) would also hit
// ordinary code, so this matches only the exact values freecode stores.
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SECRET_FILES = ["config.json", "auth.json", "mcp-auth.json"] as const;
const SECRET_KEY = /key|token|secret|password|cookie/i;
const SECRET_ENV = /(?:_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY)$/;
/** Shorter values are placeholders ("xxxxx"), not credentials. */
const MIN_LENGTH = 12;
/** See heldSecretPrefix. */
const MIN_HELD = 4;

export interface KnownSecret {
  value: string;
  /** Where it came from, e.g. `config.json providers.minimax.apiKey`. */
  label: string;
}

function collect(
  node: unknown,
  file: string,
  at: string,
  out: KnownSecret[],
): void {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    const where = at ? `${at}.${key}` : key;
    if (typeof value === "string") {
      if (SECRET_KEY.test(key) && value.length >= MIN_LENGTH) {
        out.push({ value, label: `${file} ${where}` });
      }
    } else {
      collect(value, file, where, out);
    }
  }
}

/**
 * Credential values from `~/.freecode/{config,auth,mcp-auth}.json` and from
 * key-shaped environment variables. Re-read per call: the files are small and
 * a login or `/model` key change must take effect without a restart.
 */
export function knownSecrets(
  dir = path.join(os.homedir(), ".freecode"),
  env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
  const out: KnownSecret[] = [];
  for (const file of SECRET_FILES) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    collect(parsed, file, "", out);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value && SECRET_ENV.test(name) && value.length >= MIN_LENGTH) {
      out.push({ value, label: `$${name}` });
    }
  }
  // Longest first, so a value that contains another is replaced whole.
  return out.sort((a, b) => b.value.length - a.value.length);
}

export function redactKnownSecrets(
  text: string,
  secrets: readonly KnownSecret[] = knownSecrets(),
): string {
  let result = text;
  for (const { value, label } of secrets) {
    if (result.includes(value)) {
      result = result.split(value).join(`[redacted: ${label}]`);
    }
  }
  return result;
}

/**
 * Length of the longest end of `text` that is the start (not the whole) of a
 * known secret. Output that is still arriving may complete it, so a live
 * reader holds that much back: redacting each piece on its own would miss a
 * key split across two reads and show its first half.
 */
export function heldSecretPrefix(
  text: string,
  secrets: readonly KnownSecret[],
): number {
  if (text.length === 0) return 0;
  const last = text.charCodeAt(text.length - 1);
  // A key's first few characters ("sk-") identify nothing; holding those back
  // would stall every live line that happens to end in an "s".
  let held = MIN_HELD - 1;
  for (const { value } of secrets) {
    for (let k = Math.min(value.length - 1, text.length); k > held; k--) {
      if (value.charCodeAt(k - 1) !== last) continue;
      if (text.endsWith(value.slice(0, k))) {
        held = k;
        break;
      }
    }
  }
  return held >= MIN_HELD ? held : 0;
}

/**
 * Redaction for output that arrives in chunks (a background shell's live
 * stream). `push` returns what is safe to show now; `end` releases the rest
 * once the stream is over.
 */
export function createStreamRedactor(
  secrets: readonly KnownSecret[] = knownSecrets(),
): { push(chunk: string): string; end(): string } {
  let pending = "";
  return {
    push(chunk) {
      const text = pending + chunk;
      const held = heldSecretPrefix(text, secrets);
      pending = text.slice(text.length - held);
      return redactKnownSecrets(text.slice(0, text.length - held), secrets);
    },
    end() {
      const rest = pending;
      pending = "";
      return redactKnownSecrets(rest, secrets);
    },
  };
}
