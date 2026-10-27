import { z } from 'zod';
import { parseId, parseNodes, parseTopic } from './contracts.ts';
import { DmnGateway } from './gateway.ts';
import { fail } from './errors.ts';
import { TopicRunner, type RootRuntime } from './runner.ts';
import { DmnStore } from './store.ts';

export const requestSchema = z.strictObject({
  startNode: z.string(),
  topic: z.strictObject({
    title: z.string(), initialPrompt: z.string(), participants: z.array(z.string()),
    maxModelTurns: z.number().int().positive().max(12), maxTurnsPerNode: z.number().int().positive().max(5),
    durationMinutes: z.number().int().positive().max(15),
  }),
  limits: z.unknown(),
});

/** Explicit local user command only. Node tools cannot invoke this entry point. */
export async function startDiscussion(store: DmnStore, nodeConfig: unknown, input: unknown, runtime: RootRuntime) {
  const nodes = parseNodes(nodeConfig);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) fail('VALIDATION', 'Invalid bounded discussion request.');
  const request = parsed.data;
  const startNode = parseId(request.startNode);
  const { durationMinutes, ...rest } = request.topic;
  const topicInput = parseTopic({ ...rest, deadlineAt: new Date(Date.now() + durationMinutes * 60000).toISOString() });
  const gateway = new DmnGateway(store);
  const runner = new TopicRunner(store, gateway, runtime);
  const topic = store.transaction(() => {
    nodes.forEach(node => gateway.registerNode(node));
    const topic = gateway.createTopic('local-user', topicInput);
    runner.authorize(topic.id, request.limits);
    runner.seed(topic.id, startNode);
    return topic;
  });
  await runner.runUntilIdle();
  const state = store.one<{ status: string; used_model_turns: number }>('SELECT status,used_model_turns FROM topics WHERE topic_id=?', topic.id)!;
  const count = (sql: string) => store.one<{ n: number }>(sql, topic.id)!.n;
  return { topicId: topic.id, state: state.status, reservedTurns: state.used_model_turns,
    completedTurns: count("SELECT count(*) AS n FROM model_turns WHERE topic_id=? AND status='completed'"),
    unknownTurns: count("SELECT count(*) AS n FROM model_turns WHERE topic_id=? AND status='unknown'"),
    failedTurns: count("SELECT count(*) AS n FROM model_turns WHERE topic_id=? AND status='failed'"),
    messages: count('SELECT count(*) AS n FROM messages WHERE topic_id=?'),
  };
}
