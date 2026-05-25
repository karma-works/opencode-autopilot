import type { ToolCallSummary } from "../loop/types.ts";
import type { TrustBoundary } from "../trust/types.ts";

export interface Message {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export interface ProposedToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface JudgeConfig {
  readonly provider: string | null;
  readonly model: string | null;
  readonly providerKey: string | null;
  readonly timeoutMs: number;
  readonly workspacePolicy: string;
  readonly policyTemplate: string;
}

export interface JudgeDecision {
  readonly decision: "ALLOW" | "DENY";
  readonly rationale: string;
  readonly suggestedAlternative?: string;
}

export interface JudgeModel {
  readonly complete: (prompt: string, config: JudgeConfig) => Promise<string>;
}

export interface JudgeInput {
  readonly userMessages: readonly Message[];
  readonly toolCallHistory: readonly ToolCallSummary[];
  readonly proposedCall: ProposedToolCall;
  readonly trustBoundary: TrustBoundary;
  readonly config: JudgeConfig;
  readonly model: JudgeModel;
}
