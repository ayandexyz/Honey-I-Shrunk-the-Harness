// =============================================================================
// Prompt Executor - Execute LLM-evaluated hooks
// =============================================================================

import { getProvider } from "../../providers/index.js";
import type { ProviderId } from "../../providers/index.js";
import { getCurrentModel } from "../../providers/config.js";
import type {
  HookContext,
  HookExecutionResult,
  PromptHook,
  ToolCallInput,
} from "../types.js";
import type { MemoryAuxiliaryObserver } from "../../memory/auxiliary.js";

const PROMPT_HOOK_TIMEOUT_MS = 30 * 1000;

const SYSTEM_PROMPT =
  "You evaluate whether an AI coding agent may proceed with a tool call. " +
  'Respond with ONLY a JSON object: {"decision":"allow"|"block","reason":string}. ' +
  "No other text.";

export async function executePromptHook(
  hook: PromptHook,
  input: ToolCallInput,
  context: HookContext,
  timeout?: number,
): Promise<HookExecutionResult> {
  const providerId =
    (typeof context.provider === "string" ? context.provider : undefined) ??
    getCurrentModel()?.provider;

  if (!providerId) {
    return {
      success: false,
      blocked: false,
      error:
        "Prompt hook has no provider configured (context.provider or a current model)",
    };
  }

  let provider;
  try {
    provider = getProvider(providerId as ProviderId);
  } catch (err) {
    return {
      success: false,
      blocked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const model =
    hook.model ??
    (typeof context.model === "string" ? context.model : undefined) ??
    getCurrentModel()?.model;

  const userPrompt = `${hook.prompt}\n\nTool: ${input.toolName}\nInput: ${JSON.stringify(input.toolInput, null, 2)}`;

  const controller = new AbortController();
  const startedAt = Date.now();
  const onAuxiliaryCall = context.onAuxiliaryCall as
    | MemoryAuxiliaryObserver
    | undefined;
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeout ?? PROMPT_HOOK_TIMEOUT_MS,
  );

  try {
    const result = await provider.execute({
      prompt: userPrompt,
      system: SYSTEM_PROMPT,
      model,
      maxTokens: 200,
      abortSignal: controller.signal,
    });

    onAuxiliaryCall?.({
      purpose: "hook",
      provider: result.provider,
      model: result.model,
      duration_ms: Date.now() - startedAt,
      outcome: "succeeded",
      usage: result.usage,
    });

    return parsePromptHookDecision(result.content);
  } catch (err) {
    onAuxiliaryCall?.({
      purpose: "hook",
      provider: providerId,
      model,
      duration_ms: Date.now() - startedAt,
      outcome: "failed",
    });
    return {
      success: false,
      blocked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// A prompt hook is expected to return {"decision":"allow"|"block","reason":string}.
// Non-JSON responses fail open (mirrors the command executor's plain-text
// stdout handling) since the hook prompt is user-authored and may not
// enforce the contract strictly.
function parsePromptHookDecision(content: string): HookExecutionResult {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.decision === "block") {
        return {
          success: false,
          blocked: true,
          blockReason:
            typeof parsed.reason === "string"
              ? parsed.reason
              : "Blocked by prompt hook",
        };
      }
      if (parsed.decision === "allow") {
        return {
          success: true,
          additionalContext:
            typeof parsed.reason === "string" ? parsed.reason : undefined,
        };
      }
    } catch {
      // Not valid JSON — fall through to plain-text handling below.
    }
  }

  return {
    success: true,
    additionalContext: trimmed || undefined,
  };
}
