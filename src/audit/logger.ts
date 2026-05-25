import type { Classification } from "../classifier/tier.ts";
import type { JudgeDecision } from "../judge/types.ts";
import type { AutopilotState } from "../loop/state.ts";

export interface AuditLogEntry {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly event: "session-start" | "tool-call" | "judge-decision" | "loop-detected" | "session-complete";
  readonly tool?: string;
  readonly classification?: Classification;
  readonly decision?: JudgeDecision;
  readonly message?: string;
}

export class AuditLogger {
  constructor(private readonly writeLine: (line: string) => Promise<void>) {}

  async write(entry: AuditLogEntry): Promise<void> {
    await this.writeLine(JSON.stringify(entry));
  }

  async writeCompletion(state: AutopilotState): Promise<void> {
    await this.write({
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      event: "session-complete",
      message: `Completed after ${state.stepCount} steps with ${state.totalDenials} denials.`
    });
  }
}

export function createBunAuditLogger(path: string): AuditLogger {
  return new AuditLogger(async (line) => {
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(path, `${existing}${line}\n`);
  });
}
