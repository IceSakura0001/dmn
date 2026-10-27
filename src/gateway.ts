import { randomUUID } from 'node:crypto';
import { parseId, parseMessage, parseNode, parseSend, parseTopic, type Message, type ModelNode } from './contracts.ts';
import { fail } from './errors.ts';
import { DmnStore } from './store.ts';
import { TopicManager } from './topic-manager.ts';
import { refreshNodeState } from './node-state.ts';

type NodeRow = { node_id: string; provider: string; model_id: string; session_id: string; persona_ref: string; memory_namespace: string; allowed_tools_json: string };
type TopicRow = { topic_id: string; status: string; deadline_at: string; used_model_turns: number; max_model_turns: number };
type MessageRow = {
  message_id: string; topic_id: string; from_node: string; to_node: string; type: Message['type']; content: string;
  reply_to: string | null; expect_reply: number; idempotency_key: string | null; created_at: string; expires_at: string | null;
};
type Accepted = Readonly<{ accepted: true; messageId: string; status: 'queued' }>;

/** Host-only API. bindNode is called by the trusted adapter, never by a model payload. */
export class DmnGateway {
  constructor(private readonly store: DmnStore, private readonly now: () => Date = () => new Date()) {}

  registerNode(input: unknown): ModelNode {
    const node = parseNode(input);
    return this.store.transaction(() => {
      const prior = this.store.one<NodeRow>('SELECT * FROM model_nodes WHERE node_id=?', node.id);
      if (prior) {
        if (prior.provider !== node.provider || prior.model_id !== node.model || prior.session_id !== node.sessionId || prior.persona_ref !== node.personaRef || prior.memory_namespace !== node.memoryNamespace || prior.allowed_tools_json !== JSON.stringify([...node.allowedTools].sort())) {
          fail('CONFLICT', 'A node identity cannot be rebound.');
        }
        return node;
      }
      if (this.store.one('SELECT node_id FROM model_nodes WHERE session_id=? OR memory_namespace=?', node.sessionId, node.memoryNamespace)) {
        fail('CONFLICT', 'Session or memory namespace already owned.');
      }
      this.store.run('INSERT INTO model_nodes (node_id, provider, model_id, session_id, persona_ref, memory_namespace, allowed_tools_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        node.id, node.provider, node.model, node.sessionId, node.personaRef, node.memoryNamespace, JSON.stringify([...node.allowedTools].sort()));
      this.event('node.registered', null, node.id, null);
      return node;
    });
  }

  createTopic(trustedUserId: string, input: unknown) {
    const userId = parseId(trustedUserId);
    const topic = parseTopic(input);
    const deadline = new Date(topic.deadlineAt).toISOString();
    if (deadline <= this.now().toISOString()) fail('VALIDATION', 'Topic deadline must be in the future.');
    return this.store.transaction(() => {
      for (const id of topic.participants) this.node(id);
      const id = randomUUID();
      this.store.run(`INSERT INTO topics (topic_id, created_by, title, initial_prompt, max_model_turns, max_turns_per_node, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, userId, topic.title, topic.initialPrompt, topic.maxModelTurns, topic.maxTurnsPerNode, deadline);
      for (const node of topic.participants) this.store.run('INSERT INTO topic_participants (topic_id, node_id) VALUES (?, ?)', id, node);
      this.event('topic.created', id, null, null);
      return { id, ...topic, deadlineAt: deadline, state: 'active' as const };
    });
  }

  bindNode(trustedNodeId: string) {
    const nodeId = parseId(trustedNodeId);
    const allowed = new Set<string>(JSON.parse(this.node(nodeId).allowed_tools_json));
    const authorize = (tool: string) => { if (!allowed.has(tool)) fail('FORBIDDEN', 'Tool is not allowed for this node.'); };
    // Closures retain identity without exposing store, Gateway or any host capability.
    return Object.freeze({
      send: (payload: unknown) => { authorize('model_send_message'); return this.send(nodeId, payload); },
      getInbox: () => { authorize('model_get_inbox'); return this.store.all<MessageRow>(`SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.message_id
        WHERE d.recipient_node=? AND d.status IN ('queued','retry') AND (m.expires_at IS NULL OR m.expires_at>?)
        ORDER BY m.rowid LIMIT 100`, nodeId, this.now().toISOString()).map(toMessage); },
      getThread: (topicId: string) => {
        authorize('model_get_thread');
        this.member(parseId(topicId), nodeId);
        return this.store.all<MessageRow>('SELECT * FROM messages WHERE topic_id=? AND (from_node=? OR to_node=?) ORDER BY rowid LIMIT 100', topicId, nodeId, nodeId).map(toMessage);
      },
      listPeers: (topicId: string) => {
        authorize('model_list_peers');
        this.member(parseId(topicId), nodeId);
        return this.store.all<{ id: string }>('SELECT node_id AS id FROM topic_participants WHERE topic_id=? AND node_id<>? ORDER BY node_id', topicId, nodeId);
      },
    });
  }

  private send(sender: string, payload: unknown): Accepted {
    const request = parseSend(payload);
    return this.store.transaction(() => {
      this.member(request.topicId, sender);
      this.member(request.topicId, request.to);
      if (sender === request.to) fail('FORBIDDEN', 'Self-send is not permitted.');
      const expiresAt = request.expiresAt ? new Date(request.expiresAt).toISOString() : undefined;
      if (request.idempotencyKey) {
        const prior = this.store.one<MessageRow>('SELECT * FROM messages WHERE from_node=? AND topic_id=? AND idempotency_key=?', sender, request.topicId, request.idempotencyKey);
        if (prior) {
          if (prior.to_node !== request.to || prior.type !== request.type || prior.content !== request.content || prior.reply_to !== (request.replyTo ?? null) || prior.expect_reply !== Number(request.expectReply) || prior.expires_at !== (expiresAt ?? null)) {
            fail('CONFLICT', 'Idempotency key already belongs to a different request.');
          }
          // Acknowledges the original queue insertion, not the current delivery status.
          return { accepted: true, messageId: prior.message_id, status: 'queued' };
        }
      }
      const topic = this.topic(request.topicId);
      if(this.store.one<{interaction_mode:string}>('SELECT interaction_mode FROM topics WHERE topic_id=?',request.topicId)?.interaction_mode==='direct')fail('FORBIDDEN','Direct chat cannot create peer messages.');
      const now = this.now().toISOString();
      if (!['active', 'waiting'].includes(topic.status) || topic.deadline_at <= now) fail('TOPIC_STOPPED', 'Topic is paused, closed or expired.');
      if (topic.used_model_turns >= topic.max_model_turns) fail('BUDGET_EXHAUSTED', 'Topic turn budget is exhausted.');
      const policy = new TopicManager(this.store,this.now).policy(request.topicId);
      if (policy) {
        const recent = this.store.all<{ from_node:string }>('SELECT from_node FROM messages WHERE topic_id=? ORDER BY rowid DESC LIMIT ?',request.topicId,policy.maxConsecutiveMessagesPerNode);
        if (recent.length === policy.maxConsecutiveMessagesPerNode && recent.every(m => m.from_node === sender)) fail('FORBIDDEN','Consecutive one-way message limit reached.');
      }
      if (expiresAt && expiresAt <= now) fail('VALIDATION', 'Message expiry must be in the future.');
      if (request.replyTo) {
        const parent = this.store.one<MessageRow>('SELECT * FROM messages WHERE message_id=?', request.replyTo);
        if (!parent || parent.topic_id !== request.topicId || parent.from_node !== request.to || parent.to_node !== sender) fail('FORBIDDEN', 'Reply target is outside this conversation.');
      }
      const message = parseMessage({ id: randomUUID(), from: sender, createdAt: now, ...request,
        ...(expiresAt ? { expiresAt } : {}),
      });
      this.store.run(`INSERT INTO messages (message_id, topic_id, from_node, to_node, type, content, reply_to, expect_reply, idempotency_key, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, message.id, message.topicId, sender, message.to, message.type, message.content,
        message.replyTo ?? null, Number(message.expectReply), message.idempotencyKey ?? null, now, expiresAt ?? null);
      this.store.run('INSERT INTO deliveries (delivery_id, message_id, recipient_node, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), message.id, message.to, now, now);
      this.event('message.queued', request.topicId, sender, message.id);
      if (topic.status === 'waiting') this.store.run("UPDATE topics SET status='active' WHERE topic_id=?", request.topicId);
      refreshNodeState(this.store,message.to,now);
      return { accepted: true, messageId: message.id, status: 'queued' };
    });
  }

  pauseTopic(topicId: string) { new TopicManager(this.store,this.now).pause(topicId); }
  closeTopic(topicId: string) { new TopicManager(this.store,this.now).close(topicId); }
  getAudit(topicId: string) {
    this.topic(parseId(topicId));
    return this.store.all<{ seq: number; eventType: string; nodeId: string | null; messageId: string | null; createdAt: string }>(
      'SELECT event_seq AS seq, event_type AS eventType, node_id AS nodeId, message_id AS messageId, created_at AS createdAt FROM events WHERE topic_id=? ORDER BY event_seq LIMIT 1000', topicId);
  }
  private node(nodeId: string) {
    const node = this.store.one<NodeRow>('SELECT * FROM model_nodes WHERE node_id=?', nodeId);
    if (!node) fail('FORBIDDEN', 'Node is not registered.');
    return node;
  }
  private topic(topicId: string) {
    const topic = this.store.one<TopicRow>('SELECT * FROM topics WHERE topic_id=?', topicId);
    if (!topic) fail('NOT_FOUND', 'Topic does not exist.');
    return topic;
  }
  private member(topicId: string, nodeId: string) {
    if (!this.store.one('SELECT 1 FROM topic_participants WHERE topic_id=? AND node_id=?', topicId, nodeId)) fail('FORBIDDEN', 'Node is not a topic participant.');
  }
  private event(type: string, topicId: string | null, nodeId: string | null, messageId: string | null) {
    this.store.run('INSERT INTO events (event_type, topic_id, node_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)', type, topicId, nodeId, messageId, this.now().toISOString());
  }
}

function toMessage(row: MessageRow): Message {
  return parseMessage({
    id: row.message_id, topicId: row.topic_id, from: row.from_node, to: row.to_node,
    type: row.type, content: row.content, createdAt: row.created_at, expectReply: Boolean(row.expect_reply),
    ...(row.reply_to !== null ? { replyTo: row.reply_to } : {}),
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  });
}
