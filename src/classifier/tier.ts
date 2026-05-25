export enum Tier {
  T1 = "T1",
  T2 = "T2",
  T3 = "T3"
}

export interface Classification {
  readonly tier: Tier;
  readonly reason: string;
}
