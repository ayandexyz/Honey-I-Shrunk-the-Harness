// =============================================================================
// HTTP Executor - POST the event document to a URL
// The reply body is read exactly like a command hook's stdout. Any failure — a
// non-2xx status, an unreachable host, a timeout — is a non-blocking error: a
// supervisor that went away must neither stall nor veto the agent. Only an
// explicit decision in a 2xx body can block.
// =============================================================================

import type { HookExecutionResult } from "../types.js";
import type { HookPayload } from "../payload.js";
import { parseHookOutput } from "../output.js";

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;

export interface HttpHookTarget {
  url: string;
  headers?: Record<string, string>;
  /** Variables a header may interpolate as `$NAME` or `${NAME}`. Others read as empty. */
  allowedEnvVars?: string[];
}

export interface HttpExecutorOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export async function executeHttpHook(
  target: HttpHookTarget,
  payload: HookPayload,
  options: HttpExecutorOptions = {},
): Promise<HookExecutionResult> {
  const timeout = options.timeout || HOOK_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const allowed = new Set(target.allowedEnvVars ?? []);

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    headers[name] = interpolate(value, allowed, env);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        success: false,
        blocked: false,
        error: `Hook endpoint answered ${response.status}`,
      };
    }
    return parseHookOutput(body);
  } catch (err) {
    return {
      success: false,
      blocked: false,
      error: controller.signal.aborted
        ? `Hook timed out after ${timeout}ms`
        : `Hook endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function interpolate(
  value: string,
  allowed: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const name = (braced ?? bare)!;
      return allowed.has(name) ? (env[name] ?? "") : "";
    },
  );
}
