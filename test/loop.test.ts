import { describe, expect, test } from "bun:test";
import { Tier } from "../src/classifier/tier.ts";
import { detectLoop } from "../src/loop/detector.ts";
import { AutopilotState } from "../src/loop/state.ts";
import type { ToolCallSummary } from "../src/loop/types.ts";

function call(tool: string, args: Record<string, unknown>): ToolCallSummary {
  return { tool, args, tier: Tier.T1, timestamp: Date.now() };
}

describe("detectLoop", () => {
  test("detects three identical consecutive calls", () => {
    const state = new AutopilotState({ sessionId: "s1", maxSteps: 100, timeoutMs: 60_000 });
    state.recordCall(call("read", { path: "a.ts" }));
    state.recordCall(call("read", { path: "a.ts" }));
    expect(detectLoop(state, call("read", { path: "a.ts" })).type).toBe("repetition");
  });

  test("detects A-B-A-B alternation", () => {
    const state = new AutopilotState({ sessionId: "s1", maxSteps: 100, timeoutMs: 60_000 });
    state.recordCall(call("read", { path: "a.ts" }));
    state.recordCall(call("read", { path: "b.ts" }));
    state.recordCall(call("read", { path: "a.ts" }));
    expect(detectLoop(state, call("read", { path: "b.ts" })).type).toBe("alternation");
  });

  test("detects step limit", () => {
    const state = new AutopilotState({ sessionId: "s1", maxSteps: 1, timeoutMs: 60_000 });
    state.recordCall(call("read", { path: "a.ts" }));
    expect(detectLoop(state, call("read", { path: "b.ts" })).type).toBe("step-limit");
  });
});
