import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { fail } from './errors.ts';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const route = z.string().trim().min(1).max(256).refine(value => !/REPLACE_WITH/i.test(value));
const relativePath = z.string().min(1).max(512).refine(value =>
  !/^(?:[a-zA-Z]:|[\\/])/.test(value) && !value.split(/[\\/]/).some(p => p === '..' || p === '') && !value.includes('\0'));
const nodeSchema = z.strictObject({
  id, provider: route, model: route, sessionId: id, personaRef: relativePath, memoryNamespace: id,
  allowedTools: z.array(z.enum(['model_send_message', 'model_list_peers', 'model_get_inbox', 'model_get_thread', 'model_decline_message'])).max(5),
});
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nodesSchema = z.strictObject({ nodes: z.array(nodeSchema).min(1).max(32) });
const dateTime = z.iso.datetime({ offset: true });
const topicSchema = z.strictObject({
  title: z.string().trim().min(1).max(256), initialPrompt: z.string().trim().min(1).max(8000),
  participants: z.array(id).min(2).max(32).refine(v => new Set(v).size === v.length),
  maxModelTurns: positiveInt, maxTurnsPerNode: positiveInt, deadlineAt: dateTime,
});
const sendSchema = z.strictObject({
  to: id, topicId: id, type: z.enum(['chat', 'question', 'reply']).default('chat'),
  content: z.string().min(1).max(8000).refine(v => v.trim().length > 0),
  replyTo: id.optional(), expectReply: z.boolean().default(false),
  idempotencyKey: id.optional(), expiresAt: dateTime.optional(),
});
const policySchema = z.strictObject({
  topicDefaults: z.strictObject({
    mode: z.literal('semi-autonomous'), maxModelTurns: positiveInt, maxTurnsPerNode: positiveInt,
    maxDurationMinutes: positiveInt, maxConsecutiveMessagesPerNode: positiveInt,
    maxConcurrentTurnsPerNode: z.literal(1), autoStartNewTopics: z.literal(false), allowInviteUnlistedNodes: z.literal(false),
    maxMessageChars: positiveInt.max(8000), maxInputTokens: positiveInt, maxOutputTokens: positiveInt,
    maxEstimatedCost: z.number().positive().finite(),
  }),
  delivery: z.strictObject({ leaseSeconds: positiveInt, maxAttempts: positiveInt, backoffSeconds: z.array(positiveInt).min(1).max(16), deadLetterAfterMaxAttempts: z.literal(true) }),
  memory: z.strictObject({ maxRetrievedPerTurn: z.number().int().min(3).max(8), minImportanceToPersist: z.number().min(0).max(1), identityAutoEdit: z.literal(false) }),
  security: z.strictObject({ treatPeerMessagesAsUntrusted: z.literal(true), serverSideSenderBinding: z.literal(true), allowCrossNodePrivateMemoryAccess: z.literal(false) }),
});

export type ModelNode = z.infer<typeof nodeSchema>;
export type TopicInput = z.infer<typeof topicSchema>;
export type SendInput = z.infer<typeof sendSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Message = {
  id: string; topicId: string; from: string; to: string; type: 'chat' | 'question' | 'reply'; content: string;
  createdAt: string; replyTo?: string; expectReply?: boolean; idempotencyKey?: string; expiresAt?: string;
};
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: true });
addFormats(ajv);
const messageValidator = ajv.compile<Message>(JSON.parse(readFileSync(new URL('../schemas/message.schema.json', import.meta.url), 'utf8')));

function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail('VALIDATION', 'Input does not match the DMN contract.');
  return result.data;
}
export function parseMessage(input: unknown): Message {
  if (!messageValidator(input)) fail('VALIDATION', 'Input does not match the message schema.');
  return structuredClone(input);
}
export function parseNode(input: unknown): ModelNode { return checked(nodeSchema, input); }
export function parseId(input: unknown): string { return checked(id, input); }
export function parseTopic(input: unknown): TopicInput { return checked(topicSchema, input); }
export function parseSend(input: unknown): SendInput { return checked(sendSchema, input); }
export function parsePolicy(input: unknown): Policy { return checked(policySchema, input); }
export function parseNodes(input: unknown): ModelNode[] {
  const { nodes } = checked(nodesSchema, input);
  for (const field of ['id', 'sessionId', 'memoryNamespace'] as const) {
    if (new Set(nodes.map(n => n[field])).size !== nodes.length) fail('VALIDATION', 'Node IDs, sessions and memory namespaces must be unique.');
  }
  return nodes;
}
export function readYaml(path: string): unknown {
  try {
    const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
    if (document.errors.length) fail('VALIDATION', 'Invalid YAML configuration.');
    return document.toJS({ maxAliasCount: 32 });
  } catch { fail('VALIDATION', 'Configuration is unreadable or invalid YAML.'); }
}
