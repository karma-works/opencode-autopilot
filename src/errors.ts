export class ToolBlockedError extends Error {
  readonly suggestedAlternative?: string;

  constructor(rationale: string, suggestedAlternative?: string) {
    super(suggestedAlternative ? `${rationale}\nSuggested alternative: ${suggestedAlternative}` : rationale);
    this.name = "ToolBlockedError";
    if (suggestedAlternative) this.suggestedAlternative = suggestedAlternative;
  }
}

export class LoopDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopDetectedError";
  }
}
