import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event, Message as SDKMessage, Part, TextPart } from "@opencode-ai/sdk";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBunAuditLogger } from "./audit/logger.ts";
import { classifyToolCall } from "./classifier/classify.ts";
import { Tier } from "./classifier/tier.ts";
import { loadAutoModeConfig, type RawAutoModeConfig } from "./config.ts";
import { LoopDetectedError, ToolBlockedError } from "./errors.ts";
import { judge } from "./judge/client.ts";
import { POLICY_TEMPLATE, WORKSPACE_POLICY } from "./judge/policy-content.ts";
import { createHostedJudgeModel } from "./judge/providers.ts";
import type { JudgeConfig, Message as JudgeMessage } from "./judge/types.ts";
import { detectLoop, detectTimeout } from "./loop/detector.ts";
import { loadOrInitState, persistState, type AutopilotState } from "./loop/state.ts";
import type { ToolCallSummary } from "./loop/types.ts";

function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

function textFromMessages(messages: ReadonlyArray<{ info: SDKMessage; parts: Array<Part> }>): string {
  const last = messages.filter((m) => m.info.role === "assistant").at(-1);
  if (!last) return "";
  return last.parts.filter(isTextPart).map((p) => p.text).join("\n");
}

async function log(client: PluginInput["client"], level: "debug" | "info" | "warn" | "error", message: string): Promise<void> {
  await client.app.log({ body: { service: "autopilot", level, message } });
}

async function notifyPause(client: PluginInput["client"], message: string): Promise<void> {
  await client.tui.showToast({ body: { message, variant: "error" } });
}

function buildJudgeConfig(provider: string | null, model: string | null, providerKey: string | null = null): JudgeConfig {
  return {
    provider,
    model,
    providerKey,
    timeoutMs: 5_000,
    workspacePolicy: WORKSPACE_POLICY,
    policyTemplate: POLICY_TEMPLATE
  };
}

export const AutopilotPlugin: Plugin = async (rawInput: unknown, rawOptions?: Record<string, unknown>) => {
  const { directory, client } = rawInput as PluginInput;
  const root = directory;
  const config = await loadAutoModeConfig(root, (rawOptions ?? {}) as RawAutoModeConfig);
  const opencodeDir = join(root, ".opencode");
  await mkdir(opencodeDir, { recursive: true });
  const statePath = join(opencodeDir, "autopilot-state.json");
  const auditLog = createBunAuditLogger(join(opencodeDir, "autopilot.log"));
  const judgeModel = createHostedJudgeModel();
  const sessions = new Map<string, AutopilotState>();
  const sessionAgents = new Map<string, string>();
  let activeProviderID: string | null = null;
  let activeProviderKey: string | null = null;

  await log(client, "info", `Autopilot plugin initialized. root=${root}, maxSteps=${config.maxSteps}, timeoutMs=${config.timeoutMs}`);

  async function ensureSession(sessionID: string): Promise<AutopilotState> {
    let state = sessions.get(sessionID);
    if (!state) {
      state = await loadOrInitState(statePath, sessionID, config.maxSteps, config.timeoutMs);
      sessions.set(sessionID, state);
      await auditLog.write({ timestamp: new Date().toISOString(), sessionId: sessionID, event: "session-start", message: "Session initialized on first tool call." });
    }
    return state;
  }

  return {
    "chat.params": async (input, _output): Promise<void> => {
      sessionAgents.set(input.sessionID, input.agent);
      // input.model.providerID is always present; input.provider.info may be absent in older OpenCode builds
      activeProviderID = input.model.providerID;
      // Prefer key from hook input; fall back to config.providers API (resolves env-var and config-stored keys)
      const hookKey = (input.provider as { info?: { key?: string } } | undefined)?.info?.key;
      if (hookKey) {
        activeProviderKey = hookKey;
      } else {
        try {
          const result = await client.config.providers({ query: { directory: root } });
          const match = result.data?.providers.find((p) => p.id === input.model.providerID);
          activeProviderKey = match?.key ?? null;
        } catch {
          activeProviderKey = null;
        }
      }
    },

    "tool.execute.before": async (input, output): Promise<void> => {
      if (sessionAgents.get(input.sessionID) !== "auto") return;
      const state = await ensureSession(input.sessionID);
      const args = (output.args ?? {}) as Record<string, unknown>;
      const classification = classifyToolCall(input.tool, args, config.trustBoundary);
      const call: ToolCallSummary = { tool: input.tool, args, tier: classification.tier, timestamp: Date.now() };
      const loopResult = detectLoop(state, call);
      if (loopResult.detected) {
        const message = loopResult.message ?? "Autopilot loop detected.";
        await auditLog.write({ timestamp: new Date().toISOString(), sessionId: input.sessionID, event: "loop-detected", message });
        throw new LoopDetectedError(message);
      }

      if (classification.tier === Tier.T3) {
        const judgeConfig = buildJudgeConfig(config.judge.provider ?? activeProviderID, config.judge.model, activeProviderKey);
        const decision = await judge({
          userMessages: [] satisfies readonly JudgeMessage[],
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

    "experimental.session.compacting": async (input, output): Promise<void> => {
      const state = sessions.get(input.sessionID);
      if (!state) return;
      const summary = `Autopilot state: ${state.stepCount}/${state.maxSteps} steps, ${state.totalDenials} total denials, active constraints: ${state.activeConstraints.join(", ") || "none"}.`;
      output.context.push(summary);
    },

    event: async ({ event }: { event: Event }): Promise<void> => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        sessions.delete(sessionID);
        sessionAgents.delete(sessionID);
        return;
      }

      if (event.type === "session.compacted") {
        const sessionID = event.properties.sessionID;
        const state = sessions.get(sessionID);
        if (!state) return;
        await persistState(statePath, state);
        return;
      }

      if (event.type !== "session.idle") return;

      const sessionID = event.properties.sessionID;
      const state = sessions.get(sessionID);
      if (!state) return;

      const result = await client.session.messages({ path: { id: sessionID } });
      const lastText = textFromMessages(result.data ?? []);
      if (lastText.trimEnd().endsWith("AUTOPILOT_DONE")) {
        await auditLog.writeCompletion(state);
        sessions.delete(sessionID);
        return;
      }

      if (state.circuitBreakerTripped) {
        await notifyPause(client, "[AUTO PAUSED] Circuit breaker tripped. Review .opencode/autopilot.log.");
        return;
      }

      const timeout = detectTimeout(state);
      if (timeout.detected) {
        await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "AUTOPILOT_TIMEOUT: summarize what you completed and what remains." }] } });
        return;
      }

      await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "Continue." }] } });
    }
  };
};

export default AutopilotPlugin;
