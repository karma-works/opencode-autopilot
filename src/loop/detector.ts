import type { AutopilotState } from "./state.ts";
import type { LoopDetectionResult, ToolCallSummary } from "./types.ts";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

export function callSignature(call: Pick<ToolCallSummary, "tool" | "args">): string {
  return `${call.tool}:${stableStringify(call.args)}`;
}

export function detectLoop(state: AutopilotState, newCall: ToolCallSummary): LoopDetectionResult {
  if (state.stepCount + 1 > state.maxSteps) {
    return { detected: true, type: "step-limit", message: `Autopilot reached the step limit of ${state.maxSteps}.` };
  }

  const now = Date.now();
  if (now - state.startedAt > state.timeoutMs) {
    return { detected: true, type: "timeout", message: "Autopilot reached the wall-clock timeout." };
  }

  const signatures = [...state.callHistory.map(callSignature), callSignature(newCall)];
  const lastThree = signatures.slice(-3);
  if (lastThree.length === 3 && lastThree.every((signature) => signature === lastThree[0])) {
    return { detected: true, type: "repetition", message: "Autopilot repeated the same tool call three times." };
  }

  const lastFour = signatures.slice(-4);
  if (lastFour.length === 4 && lastFour[0] === lastFour[2] && lastFour[1] === lastFour[3] && lastFour[0] !== lastFour[1]) {
    return { detected: true, type: "alternation", message: "Autopilot alternated between the same two tool calls twice." };
  }

  return { detected: false };
}

export function detectTimeout(state: AutopilotState): LoopDetectionResult {
  return Date.now() - state.startedAt > state.timeoutMs
    ? { detected: true, type: "timeout", message: "Autopilot reached the wall-clock timeout." }
    : { detected: false };
}
