// =============================================================================
// Freecode Command — sends prompt to CLI via IPC
// =============================================================================

import chalk from "chalk";
import {
  registerCommand,
  type Command,
  type CommandContext,
} from "../index.js";
import {
  startCli,
  sessionStart,
  sessionSendStreaming,
  listProviders,
  type SessionInfo,
} from "../../ipc/client.js";
import { playAlert } from "./alert.js";
import {
  getRandomElapsedPhrase,
  getRandomInProgressPhrase,
} from "../../utils/elapsed-phrases.js";
import { formatTokenCount } from "../../utils/format-tokens.js";
import { formatDuration } from "../../utils/format-duration.js";
import { finishWorkingState } from "../../utils/finish-working-state.js";

// State
let currentSession: SessionInfo | null = null;
let providersLoaded = false;
let cachedProviders: Array<{ id: string; name: string }> = [];
let currentProvider = "minimax";

async function ensureProviders(): Promise<void> {
  if (!providersLoaded) {
    try {
      const providers = await listProviders();
      cachedProviders = providers.map((p: { id: string; name: string }) => ({
        id: p.id,
        name: p.name,
      }));
    } catch {
      cachedProviders = [{ id: "minimax", name: "MiniMax" }];
    }
    providersLoaded = true;
  }
}

function formatProviderList(): string {
  return cachedProviders
    .map(
      (p) =>
        `- **${p.name}** (${p.id})${p.id === currentProvider ? " *(current)*" : ""}`,
    )
    .join("\n");
}

async function ensureSession(ctx: CommandContext): Promise<boolean> {
  if (currentSession) return true;

  startCli();

  try {
    currentSession = await sessionStart({
      projectPath: process.cwd(),
      provider: currentProvider,
    });
    return true;
  } catch (error) {
    ctx.showMessage(
      `Failed to start session: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

const freecodeCommand: Command = {
  name: "freecode",
  description: "Send prompt to AI and apply file changes",
  execute: async (args, ctx) => {
    const userPrompt = args.join(" ");

    if (!userPrompt.trim()) {
      await ensureProviders();
      ctx.showMessage(`**Usage:** /freecode <your prompt>

**Example:** /freecode say hello

**Available providers:**
${formatProviderList()}`);
      return;
    }

    // Show user message with gray background
    ctx.createUserMessage(`**You:** ${userPrompt}`);

    // Show in-progress message and track it for later removal
    const inProgressMsg = ctx.createInProgressMessage(
      getRandomInProgressPhrase(),
    );
    const inProgressId = inProgressMsg.id;
    const startTime = Date.now();

    const ready = await ensureSession(ctx);
    if (!ready) return;

    try {
      const result = await sessionSendStreaming(
        currentSession!.sessionId,
        userPrompt,
        undefined,
        "build",
        undefined,
        (event: import("@thisisayande/freecode-shared").StreamEvent) =>
          ctx.handleToolEvent?.(event),
      );

      // Spec 2026-08-05: same as submitPrompt — a queued result means the
      // turn is parked, not started. The message_queued event handler in
      // index.ts renders the canonical queued_user row; we just drop our
      // in-progress placeholder and bail.
      if ("queued" in result) {
        ctx.removeMessageById(inProgressId);
        return;
      }

      // Match normal prompt submission: the live row ends as soon as core is
      // done, while the settled row below retains duration and token totals.
      const elapsed = finishWorkingState(
        (id) => ctx.removeMessageById(id),
        inProgressId,
        startTime,
      );
      const timeStr = formatDuration(elapsed);

      if (result.success) {
        const response = result.content || result.message;
        ctx.createAssistantMessage(`**FreeCode:** ${response || "Done!"}`);
        const inTokens = result.usage?.inputTokens ?? 0;
        const outTokens = result.usage?.outputTokens ?? 0;
        const cachedTokens = result.usage?.cacheReadInputTokens ?? 0;
        let tokenInfo = `↓${formatTokenCount(inTokens)} ↑${formatTokenCount(outTokens)}`;
        if (cachedTokens > 0) {
          tokenInfo += ` cached: ${formatTokenCount(cachedTokens)}`;
        }
        ctx.createSystemMessage(
          `${getRandomElapsedPhrase()} for ${timeStr} ${tokenInfo} (x${result.turnCount || 1})`,
        );
        playAlert();
      } else {
        ctx.createSystemMessage(
          `**Error:** ${result.message || "Unknown error"}`,
        );
        ctx.createSystemMessage(`${getRandomElapsedPhrase()} for ${timeStr}`);
        playAlert();
      }
    } catch (error) {
      ctx.removeMessageById(inProgressId);
      ctx.showMessage(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      playAlert();
    }
  },
};

export function registerFreecodeCommand(): void {
  registerCommand(freecodeCommand);
}
