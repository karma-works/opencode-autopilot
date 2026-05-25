import { join } from "node:path";
import type { AutoModeConfig } from "./trust/types.ts";

interface RawAutoModeConfig {
  readonly maxSteps?: unknown;
  readonly timeoutMinutes?: unknown;
  readonly writableRoots?: unknown;
  readonly allowedNetworkHosts?: unknown;
  readonly bashFastScreen?: unknown;
  readonly judgeIncludeRemoteOutputs?: unknown;
  readonly judge?: {
    readonly provider?: unknown;
    readonly model?: unknown;
  };
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function loadAutoModeConfig(projectRoot: string): Promise<AutoModeConfig> {
  const configPath = join(projectRoot, "opencode.json");
  const file = Bun.file(configPath);
  const root = (await file.exists()) ? ((await file.json()) as { readonly autoMode?: RawAutoModeConfig }) : {};
  const autoMode = root.autoMode ?? {};
  const maxSteps = typeof autoMode.maxSteps === "number" && autoMode.maxSteps > 0 ? autoMode.maxSteps : 100;
  const timeoutMinutes = typeof autoMode.timeoutMinutes === "number" && autoMode.timeoutMinutes > 0 ? autoMode.timeoutMinutes : 30;
  const judge = autoMode.judge ?? {};

  return {
    maxSteps,
    timeoutMs: timeoutMinutes * 60_000,
    bashFastScreen: autoMode.bashFastScreen === true,
    judgeIncludeRemoteOutputs: autoMode.judgeIncludeRemoteOutputs === true,
    trustBoundary: {
      cwd: projectRoot,
      writableRoots: stringArray(autoMode.writableRoots, ["."]),
      allowedNetworkHosts: stringArray(autoMode.allowedNetworkHosts, [])
    },
    judge: {
      provider: nullableString(judge.provider),
      model: nullableString(judge.model)
    }
  };
}
