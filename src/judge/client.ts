import type { JudgeDecision, JudgeInput } from "./types.ts";

function parseDecision(text: string): JudgeDecision {
  const parsed = JSON.parse(text) as {
    readonly outcome?: unknown;
    readonly rationale?: unknown;
    readonly suggested_alternative?: unknown;
  };
  if (parsed.outcome === "allow") return { decision: "ALLOW", rationale: typeof parsed.rationale === "string" ? parsed.rationale : "Judge allowed the action." };
  if (parsed.outcome === "deny") {
    const decision: JudgeDecision = {
      decision: "DENY",
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "Judge denied the action."
    };
    if (typeof parsed.suggested_alternative === "string") return { ...decision, suggestedAlternative: parsed.suggested_alternative };
    return decision;
  }
  throw new Error("Judge response did not contain an allow/deny outcome.");
}

function stripRemoteOutputs(history: JudgeInput["toolCallHistory"]): readonly JudgeInput["toolCallHistory"][number][] {
  return history.map((call) => {
    if (call.tool.toLowerCase() === "webfetch") return { ...call, args: { ...call.args, output: "<remote output stripped>" } };
    const command = typeof call.args.command === "string" ? call.args.command : "";
    if (call.tool.toLowerCase() === "bash" && /\b(curl|wget|ssh|scp|rsync)\b/.test(command)) {
      return { ...call, args: { ...call.args, output: "<remote output stripped>" } };
    }
    return call;
  });
}

export function buildJudgePrompt(input: Omit<JudgeInput, "model">): string {
  const policy = input.config.policyTemplate.replace("{workspace_policy}", input.config.workspacePolicy);
  return [
    policy,
    "",
    "# Trust Boundary",
    JSON.stringify(input.trustBoundary, null, 2),
    "",
    "# User Messages",
    JSON.stringify(input.userMessages, null, 2),
    "",
    "# Tool Call History",
    JSON.stringify(stripRemoteOutputs(input.toolCallHistory), null, 2),
    "",
    "# Proposed Action",
    JSON.stringify(input.proposedCall, null, 2)
  ].join("\n");
}

export async function judge(input: JudgeInput): Promise<JudgeDecision> {
  const prompt = buildJudgePrompt(input);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Judge timed out.")), input.config.timeoutMs);
  });

  try {
    const response = await Promise.race([input.model.complete(prompt, input.config), timeout]);
    return parseDecision(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown judge failure.";
    return { decision: "DENY", rationale: `Judge failed closed: ${message}` };
  }
}
