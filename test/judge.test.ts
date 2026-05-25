import { describe, expect, test } from "bun:test";
import { judge } from "../src/judge/client.ts";
import type { JudgeInput } from "../src/judge/types.ts";

const baseInput: Omit<JudgeInput, "model"> = {
  userMessages: [{ role: "user", text: "Run tests." }],
  toolCallHistory: [],
  proposedCall: { tool: "bash", args: { command: "npm test" } },
  trustBoundary: { cwd: "/workspace/project", writableRoots: ["."], allowedNetworkHosts: [] },
  config: {
    provider: null,
    model: null,
    providerKey: null,
    timeoutMs: 50,
    workspacePolicy: "Allow low-risk local actions.",
    policyTemplate: "{workspace_policy}"
  }
};

describe("judge", () => {
  test("maps allow response", async () => {
    const decision = await judge({ ...baseInput, model: { complete: async () => '{"outcome":"allow"}' } });
    expect(decision.decision).toBe("ALLOW");
  });

  test("maps deny response with alternative", async () => {
    const decision = await judge({
      ...baseInput,
      model: { complete: async () => '{"outcome":"deny","rationale":"too risky","suggested_alternative":"use a structured read"}' }
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.suggestedAlternative).toBe("use a structured read");
  });

  test("fails closed on unparseable response", async () => {
    const decision = await judge({ ...baseInput, model: { complete: async () => "not json" } });
    expect(decision.decision).toBe("DENY");
  });
});
