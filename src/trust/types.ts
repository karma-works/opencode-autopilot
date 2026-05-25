export interface TrustBoundary {
  readonly cwd: string;
  readonly writableRoots: readonly string[];
  readonly allowedNetworkHosts: readonly string[];
}

export interface AutoModeConfig {
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly trustBoundary: TrustBoundary;
  readonly bashFastScreen: boolean;
  readonly judgeIncludeRemoteOutputs: boolean;
  readonly judge: {
    readonly provider: string | null;
    readonly model: string | null;
  };
}
