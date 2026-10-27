import { z } from 'zod';

// Candidate items are validated independently after a confirmed turn; invalid memory
// suggestions must not discard an otherwise valid message. No owner identity is accepted.
const memories = z.array(z.unknown()).max(3).default([]);
export const modelOutputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('send'), to: z.string().min(1).max(128), content: z.string().min(1).max(8000), type: z.enum(['chat','question','reply']).optional(), memories }),
  z.strictObject({ action: z.literal('reply_user'), content: z.string().trim().min(1).max(8000), memories }),
  z.strictObject({ action: z.literal('decline'), memories }),
  z.strictObject({ action: z.literal('silent'), memories }),
]);

export type ModelOutput = z.output<typeof modelOutputSchema>;
/** Classify the whole response; never extract a substring or repair model text. */
export function decodeModelOutput(text: string):
  { success: true; data: ModelOutput } | { success: false; reason: 'invalid_json' | 'invalid_envelope' } {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { success: false, reason: 'invalid_json' }; }
  const parsed = modelOutputSchema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false, reason: 'invalid_envelope' };
}
