export interface GenerateRequest {
  system: string;
  input: string;
  schemaName: string;
  maxOutputTokens: number;
}

export interface GenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  modelVersion: string;
}

export interface ModelProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
