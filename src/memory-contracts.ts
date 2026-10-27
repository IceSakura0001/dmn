import { z } from 'zod';
import { fail } from './errors.ts';

export const memoryKinds = ['identity','episodic','semantic','relationship'] as const;
export const memoryCandidateSchema = z.strictObject({
  kind: z.enum(['episodic','semantic','relationship']),
  content: z.string().trim().min(1).max(1000),
  claimKey: z.string().trim().min(1).max(128).optional(),
  subjective: z.boolean(), confidence: z.number().min(0).max(1), importance: z.number().min(0).max(1),
  sourceMessageIds: z.array(z.string().min(1).max(128)).min(1).max(8).refine(v => new Set(v).size === v.length),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export function contentKey(content: string): string { return content.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
export function rejectOwner(input: unknown) {
  if (input && typeof input === 'object' && ('ownerNodeId' in input || 'owner_node_id' in input || 'from' in input)) fail('FORBIDDEN', 'Memory identity must come from trusted context.');
}
export function checkedMemory<T>(schema: z.ZodType<T>, input: unknown): T {
  rejectOwner(input);
  const result = schema.safeParse(input);
  if (!result.success) fail('VALIDATION', 'Input does not match the private memory contract.');
  return result.data;
}
export function checkMemoryText(text: string) {
  if (/\b(?:sk-[a-zA-Z0-9_-]{16,}|(?:api[_ -]?key|password|token)\s*[:=]\s*\S{8,})/i.test(text)) fail('VALIDATION', 'Credential-like material cannot be persisted as memory.');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) && secret && secret.length >= 8 && text.includes(secret)) fail('VALIDATION', 'Credential-like material cannot be persisted as memory.');
  }
}
