import type { HttpMethod } from "./workload-plan";

export type WithheldBaseline = Readonly<{
  operationKey: string;
  sourceMethod: HttpMethod;
  reason: "withheldUnsafe";
}>;

export type RestBaselineSetup = Readonly<{
  withheld: readonly WithheldBaseline[];
  measuredProbes: number;
}>;
