import { z } from 'zod';
import { fail } from './errors.ts';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nodeLimit = z.strictObject({ maxTurns: integer.optional(), maxInputTokens: integer.optional(), maxOutputTokens: integer.optional(),
  maxEstimatedCost: z.number().positive().finite().optional(), deadlineAt: z.iso.datetime({ offset: true }).optional() });
export const executionSchema = z.strictObject({
  maxInputTokens: integer, maxOutputTokens: integer, maxEstimatedCost: z.number().positive().finite(),
  inputTokensPerTurn: integer, outputTokensPerTurn: integer, estimatedCostPerTurn: z.number().positive().finite(),
  turnTimeoutMs: integer.min(100).max(300000),
  maxAttempts: integer.max(5).default(3), backoffSeconds: z.array(z.number().positive().finite().max(3600)).min(1).max(5).default([5,30,180]),
  maxConsecutiveMessagesPerNode: integer.max(2).default(2), nodeLimits: z.record(z.string(), nodeLimit).default({}),
});
export type ExecutionLimits = z.input<typeof executionSchema>;
export type ExecutionPolicy = z.output<typeof executionSchema>;
export function parseExecution(input: unknown): ExecutionPolicy {
  const result = executionSchema.safeParse(input);
  if (!result.success) fail('VALIDATION', 'Explicit bounded execution policy is required.');
  return result.data;
}
