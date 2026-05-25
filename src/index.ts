import type { Plugin } from "@opencode-ai/plugin";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBunAuditLogger } from "./audit/logger.ts";
import { classifyToolCall } from "./classifier/classify.ts";
import { Tier } from "./classifier/tier.ts";
import { loadAutoModeConfig } from "./config.ts";
import { LoopDetectedError, ToolBlockedError } from "./errors.ts";
import { judge } from "./judge/client.ts";
import { createHostedJudgeModel } from "./judge/providers.ts";
import type { JudgeConfig, Message } from "./judge/types.ts";
import { detectLoop, detectTimeout } from "./loop/detector.ts";
import { loadOrInitState, persistState, type AutopilotState } from "./loop/state.ts";
import type { ToolCallSummary } from "./loop/types.ts";

interface PluginProject {
  readonly root?: string;
  readonly path?: string;
}

interface LogClient {
  readonly app?: {
    readonly log?: (input: { readonly level: "info" | "warn" | "error"; readonly message: string }) => Promise<void>;
  };
  readonly session?: {
    readonly prompt?: (input: { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly { readonly type: "text"; readonly text: string }[] } }) => Promise<unknown>;
    readonly messages?: (input: { readonly path: { readonly id: string } }) => Promise<{ readonly data?: readonly SessionMessage[] }>;
  };
}

interface SessionMessage {
  readonly info?: { readonly role?: string };
  readonly parts?: readonly { readonly type?: string; readonly text?: string }[];
}

interface PluginContext {
  readonly project?: PluginProject;
  readonly directory?: string;
  readonly serverUrl?: string | URL;
  readonly client?: LogClient;
}

interface ToolInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

interface ToolOutput {
  readonly args?: Record<string, unknown>;
}

interface EventInput {
  readonly event: {
    readonly type: string;
    readonly properties?: Record<string, unknown>;
  };
}

function projectRoot(context: PluginContext): string {
  return context.project?.root ?? context.project?.path ?? context.directory ?? process.cwd();
}

function sessionIdFromEvent(event: EventInput["event"]): string | undefined {
  const properties = event.properties;
  if (!properties) return undefined;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (typeof properties.sessionId === "string") return properties.sessionId;
  const info = properties.info;
  if (typeof info === "object" && info !== null && "id" in info) {
    const id = (info as { readonly id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

function textFromMessages(messages: readonly SessionMessage[]): string {
  const assistants = messages.filter((message) => message.info?.role === "assistant");
  const last = assistants.at(-1);
  return last?.parts?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
}

async function log(client: LogClient | undefined, level: "info" | "warn" | "error", message: string): Promise<void> {
  await client?.app?.log?.({ level, message });
}

async function readJudgeConfig(root: string, provider: string | null, model: string | null): Promise<JudgeConfig> {
  const [workspacePolicy, policyTemplate] = await Promise.all([
    Bun.file(join(root, "src/judge/policy.md")).text(),
    Bun.file(join(root, "src/judge/policy-template.md")).text()
  ]);
  return { provider, model, timeoutMs: 5_000, workspacePolicy, policyTemplate };
}

async function notifyPause(serverUrl: string | URL | undefined, message: string): Promise<void> {
  if (!serverUrl) return;
  // PHASE1-WORKAROUND: use the HTTP TUI publish endpoint until OpenCode exposes a stable SDK method.
  await fetch(new URL("/tui/publish", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "tui.toast.show", properties: { message, variant: "error" } })
  });
}

export const AutopilotPlugin: Plugin = async (rawContext: unknown) => {
  const context = rawContext as PluginContext;
  const root = projectRoot(context);
  const config = await loadAutoModeConfig(root);
  const opencodeDir = join(root, ".opencode");
  await mkdir(opencodeDir, { recursive: true });
  const statePath = join(opencodeDir, "autopilot-state.json");
  const auditLog = createBunAuditLogger(join(opencodeDir, "autopilot.log"));
  const judgeConfig = await readJudgeConfig(root, config.judge.provider, config.judge.model);
  const judgeModel = createHostedJudgeModel();
  const sessions = new Map<string, AutopilotState>();

  return {
    "tool.execute.before": async (input: ToolInput, output: ToolOutput): Promise<void> => {
      const state = sessions.get(input.sessionID);
      if (!state) return;
      const args = output.args ?? {};
      const classification = classifyToolCall(input.tool, args, config.trustBoundary);
      const call: ToolCallSummary = { tool: input.tool, args, tier: classification.tier, timestamp: Date.now() };
      const loopResult = detectLoop(state, call);
      if (loopResult.detected) {
        const message = loopResult.message ?? "Autopilot loop detected.";
        await auditLog.write({ timestamp: new Date().toISOString(), sessionId: input.sessionID, event: "loop-detected", message });
        throw new LoopDetectedError(message);
      }

      if (classification.tier === Tier.T3) {
        const decision = await judge({
          userMessages: [] satisfies readonly Message[],
          toolCallHistory: state.callHistory,
          proposedCall: { tool: input.tool, args },
          trustBoundary: config.trustBoundary,
          config: judgeConfig,
          model: judgeModel
        });
        await auditLog.write({ timestamp: new Date().toISOString(), sessionId: input.sessionID, event: "judge-decision", tool: input.tool, classification, decision });
        if (decision.decision === "DENY") {
          state.recordDenial(decision.suggestedAlternative ? { rationale: decision.rationale, suggestedAlternative: decision.suggestedAlternative } : { rationale: decision.rationale });
          await persistState(statePath, state);
          throw new ToolBlockedError(decision.rationale, decision.suggestedAlternative);
        }
      }

      state.recordCall({ ...call, decision: "ALLOW" });
      await auditLog.write({ timestamp: new Date().toISOString(), sessionId: input.sessionID, event: "tool-call", tool: input.tool, classification });
      await persistState(statePath, state);
    },

    "experimental.session.compacting": async (input: { readonly sessionID?: string; readonly sessionId?: string }, output: { readonly context?: string[] }): Promise<void> => {
      const sessionID = input.sessionID ?? input.sessionId;
      const state = sessionID ? sessions.get(sessionID) : undefined;
      if (!state) return;
      const summary = `Autopilot state: ${state.stepCount}/${state.maxSteps} steps, ${state.totalDenials} total denials, active constraints: ${state.activeConstraints.join(", ") || "none"}.`;
      if (Array.isArray(output.context)) output.context.push(summary);
    },

    event: async (input: EventInput): Promise<void> => {
      const sessionID = sessionIdFromEvent(input.event);
      if (!sessionID) return;

      if (input.event.type === "session.created") {
        const state = await loadOrInitState(statePath, sessionID, config.maxSteps, config.timeoutMs);
        sessions.set(sessionID, state);
        await auditLog.write({ timestamp: new Date().toISOString(), sessionId: sessionID, event: "session-start", message: "Autopilot session initialized." });
        return;
      }

      const state = sessions.get(sessionID);
      if (!state) return;

      if (input.event.type === "session.compacted") {
        await persistState(statePath, state);
        return;
      }

      if (input.event.type !== "session.idle") return;

      // PHASE1-WORKAROUND: poll recent messages for the AUTOPILOT_DONE sentinel until OpenCode exposes completion state in the idle event.
      const messages = await context.client?.session?.messages?.({ path: { id: sessionID } });
      const lastText = textFromMessages(messages?.data ?? []);
      if (lastText.trimEnd().endsWith("AUTOPILOT_DONE")) {
        await auditLog.writeCompletion(state);
        sessions.delete(sessionID);
        return;
      }

      if (state.circuitBreakerTripped) {
        await notifyPause(context.serverUrl, "[AUTO PAUSED] Circuit breaker tripped. Review .opencode/autopilot.log.");
        return;
      }

      const timeout = detectTimeout(state);
      if (timeout.detected) {
        await context.client?.session?.prompt?.({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "AUTOPILOT_TIMEOUT: summarize what you completed and what remains." }] } });
        return;
      }

      await context.client?.session?.prompt?.({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "Continue." }] } });
    }
  };
};

export default AutopilotPlugin;
