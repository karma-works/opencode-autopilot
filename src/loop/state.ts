import type { DenialSummary, AutopilotStateSnapshot, ToolCallSummary } from "./types.ts";

const historyLimit = 50;

export class AutopilotState {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly callHistory: ToolCallSummary[];
  readonly denials: DenialSummary[];
  readonly activeConstraints: string[];
  stepCount: number;
  consecutiveDenials: number;
  totalDenials: number;
  circuitBreakerTripped: boolean;

  constructor(input: {
    readonly sessionId: string;
    readonly startedAt?: number;
    readonly maxSteps: number;
    readonly timeoutMs: number;
    readonly callHistory?: readonly ToolCallSummary[];
    readonly denials?: readonly DenialSummary[];
    readonly activeConstraints?: readonly string[];
    readonly stepCount?: number;
    readonly consecutiveDenials?: number;
    readonly totalDenials?: number;
    readonly circuitBreakerTripped?: boolean;
  }) {
    this.sessionId = input.sessionId;
    this.startedAt = input.startedAt ?? Date.now();
    this.maxSteps = input.maxSteps;
    this.timeoutMs = input.timeoutMs;
    this.callHistory = [...(input.callHistory ?? [])];
    this.denials = [...(input.denials ?? [])];
    this.activeConstraints = [...(input.activeConstraints ?? [])];
    this.stepCount = input.stepCount ?? this.callHistory.length;
    this.consecutiveDenials = input.consecutiveDenials ?? 0;
    this.totalDenials = input.totalDenials ?? this.denials.length;
    this.circuitBreakerTripped = input.circuitBreakerTripped ?? false;
  }

  recordCall(call: ToolCallSummary): void {
    this.stepCount += 1;
    this.callHistory.push(call);
    while (this.callHistory.length > historyLimit) this.callHistory.shift();
    if (call.decision !== "DENY") this.consecutiveDenials = 0;
  }

  recordDenial(denial: Omit<DenialSummary, "timestamp">): void {
    this.denials.push({ ...denial, timestamp: Date.now() });
    this.consecutiveDenials += 1;
    this.totalDenials += 1;
    if (this.consecutiveDenials >= 3 || this.totalDenials >= 10) this.circuitBreakerTripped = true;
  }

  snapshot(): AutopilotStateSnapshot {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      stepCount: this.stepCount,
      callHistory: this.callHistory,
      denials: this.denials,
      consecutiveDenials: this.consecutiveDenials,
      totalDenials: this.totalDenials,
      circuitBreakerTripped: this.circuitBreakerTripped,
      activeConstraints: this.activeConstraints
    };
  }
}

export async function loadOrInitState(path: string, sessionId: string, maxSteps: number, timeoutMs: number): Promise<AutopilotState> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const parsed = (await file.json()) as Record<string, unknown>;
    const saved = parsed[sessionId] as AutopilotStateSnapshot | undefined;
    if (saved) return new AutopilotState({ ...saved, maxSteps, timeoutMs });
  }
  return new AutopilotState({ sessionId, maxSteps, timeoutMs });
}

export async function persistState(path: string, state: AutopilotState): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : {};
  existing[state.sessionId] = state.snapshot();
  await Bun.write(path, JSON.stringify(existing, null, 2));
}
