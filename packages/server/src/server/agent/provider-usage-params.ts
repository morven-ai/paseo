import { z } from "zod";

const ProviderUsageParamsSchema = z
  .object({
    contextSource: z.literal("assistant-message").optional(),
    showCost: z.boolean().optional(),
    quotaProvider: z.literal("codex").optional(),
  })
  .strict();

const ProviderParamsSchema = z
  .object({
    usage: ProviderUsageParamsSchema.optional(),
  })
  .passthrough();

export type ProviderUsageParams = z.infer<typeof ProviderUsageParamsSchema>;

export function parseProviderUsageParams(params: unknown): ProviderUsageParams {
  return ProviderParamsSchema.parse(params ?? {}).usage ?? {};
}
