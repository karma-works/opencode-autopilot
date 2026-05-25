import type { Tier } from "../classifier/tier.ts";

export interface ToolCallSummary {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly tier?: Tier;
  readonly decision?: "ALLOW" | "DENY";
  readonly timestamp: number;
}

export interface DenialSummary {
  readonly rationale: string;
  readonly suggestedAlternative?: string;
  readonly timestamp: number;
}

export interface LoopDetectionResult {
  readonly detected: boolean;
  readonly type?: "repetition" | "alternation" | "step-limit" | "timeout";
  readonly message?: string;
}

export interface AutopilotStateSnapshot {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly stepCount: number;
  readonly callHistory: readonly ToolCallSummary[];
  readonly denials: readonly DenialSummary[];
  readonly consecutiveDenials: number;
  readonly totalDenials: number;
  readonly circuitBreakerTripped: boolean;
  readonly activeConstraints: readonly string[];
}
