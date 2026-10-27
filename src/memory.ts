import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseId } from './contracts.ts';
import { DmnError, fail } from './errors.ts';
import { checkedMemory, checkMemoryText, contentKey, memoryCandidateSchema, memoryKinds, rejectOwner, type MemoryCandidate } from './memory-contracts.ts';
import { DmnStore } from './store.ts';

type Row = { memory_id: string; owner_node_id: string; kind: typeof memoryKinds[number]; content: string; subjective: number;
  confidence: number; importance: number; source_message_ids_json: string; claim_key: string | null; version: number;
  created_at: string; updated_at: string; archived_at: string | null; provenance: 'legacy' | 'human' | 'candidate' };
export type MemoryRecord = ReturnType<typeof record>;
export type MemoryOutcome = { status: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; memoryId?: string; candidateId?: string; reason?: string };
const id = z.string().min(1).max(128);
const reason = z.string().trim().min(1).max(512);
const version = z.number().int().positive();
const listSchema = z.strictObject({ kind: z.enum(memoryKinds).optional(), sourceMessageId: id.optional(), limit: z.number().int().min(1).max(100).default(20) });
const searchSchema = z.strictObject({ query: z.string().trim().min(1).max(256), kind: z.enum(memoryKinds).optional(), limit: z.number().int().min(3).max(8).default(5) });
const revisionSchema = memoryCandidateSchema.extend({ memoryId: id, expectedVersion: version, reason });
const deleteSchema = z.strictObject({ memoryId: id, expectedVersion: version, reason });
const resolveSchema = z.strictObject({ candidateId: id, expectedVersion: version, reason });

/** Trusted factory. Never expose this manager, Store or the admin methods to a model. */
export class MemoryManager {
  constructor(private readonly store: DmnStore, private readonly now: () => Date = () => new Date()) {}

  bindNode(trustedNodeId: string) {
    const owner = parseId(trustedNodeId);
    this.node(owner);
    return Object.freeze({
      propose: (input: unknown) => this.propose(owner, input),
      get: (memoryId: string) => record(this.own(owner, parseId(memoryId))),
      list: (input: unknown = {}) => this.list(owner, input),
      search: (input: unknown) => this.search(owner, input),
      sources: (memoryId: string) => this.sources(owner, memoryId),
      history: (memoryId: string) => {
        this.own(owner, parseId(memoryId), true);
        return this.store.all<{ prior_json: string; new_json: string; prior_content: string; new_content: string; reason: string; revised_at: string }>(`SELECT r.* FROM memory_revisions r
          JOIN memories m ON m.memory_id=r.memory_id WHERE m.owner_node_id=? AND m.memory_id=? ORDER BY r.rowid`, owner, memoryId)
          .map(row => ({ prior: revisionSnapshot(row.prior_json, row.prior_content), next: revisionSnapshot(row.new_json, row.new_content),
            legacySnapshot: row.prior_json === '{}' || row.new_json === '{}', reason: row.reason, revisedAt: row.revised_at }));
      },
      revise: (input: unknown) => this.revise(owner, input),
      delete: (input: unknown) => this.remove(owner, input),
      archive: (input: unknown) => this.remove(owner, input, 'memory.archived'),
      listCandidates: (input: unknown = {}) => {
        const query = checkedMemory(z.strictObject({ status: z.enum(['conflict','resolved']).default('conflict') }), input);
        return this.store.all<{ candidate_id: string; memory_id: string; candidate_json: string; status: string }>(
          'SELECT * FROM memory_candidates WHERE owner_node_id=? AND status=? ORDER BY rowid LIMIT 100', owner, query.status)
          .map(row => ({ id: row.candidate_id, memoryId: row.memory_id, candidate: JSON.parse(row.candidate_json) as MemoryCandidate, status: row.status }));
      },
      resolveConflict: (input: unknown) => this.resolve(owner, input),
    });
  }

  /** Human-reviewed supplemental identity. No node capability delegates to this method. */
  setIdentity(trustedOwner: string, input: unknown): MemoryRecord {
    const owner = parseId(trustedOwner); this.node(owner);
    const value = checkedMemory(z.strictObject({ content: z.string().trim().min(1).max(1000), reason, expectedVersion: version.optional() }), input);
    checkMemoryText(value.content); checkMemoryText(value.reason);
    return this.store.transaction(() => {
      const prior = this.store.one<Row>("SELECT * FROM memories WHERE owner_node_id=? AND kind='identity' AND archived_at IS NULL ORDER BY rowid LIMIT 1", owner);
      if (prior) {
        if (value.expectedVersion !== prior.version) fail('CONFLICT', 'Identity update requires the current version.');
        return this.update(owner, prior, { content: value.content, subjective: false, confidence: 1, importance: 1, sourceMessageIds: [] }, value.reason);
      }
      const memoryId = randomUUID();
      this.store.run(`INSERT INTO memories(memory_id,owner_node_id,kind,content,subjective,confidence,importance,source_message_ids_json,content_key,created_at,updated_at,provenance)
        VALUES(?,?,'identity',?,0,1,1,'[]',?,?,?,'human')`, memoryId, owner, value.content, contentKey(value.content), this.now().toISOString(), this.now().toISOString());
      this.event('memory.identity_created', owner, memoryId);
      return record(this.own(owner, memoryId));
    });
  }

  deleteIdentity(trustedOwner: string, input: unknown) {
    const owner = parseId(trustedOwner); this.node(owner);
    return this.remove(owner, input, 'memory.identity_deleted', true);
  }

  /** Host-only: completed-turn identity and actual incoming evidence restrict model candidates. */
  acceptTurn(trustedOwner: string, turnId: string, candidates: unknown[]): MemoryOutcome[] {
    const owner = parseId(trustedOwner); parseId(turnId);
    if (!Array.isArray(candidates) || candidates.length > 3) fail('VALIDATION', 'At most three memory candidates per turn.');
    return this.store.transaction(() => {
      const turn = this.store.one<{ input_message_id: string | null }>("SELECT input_message_id FROM model_turns WHERE turn_id=? AND node_id=? AND status='completed'", turnId, owner);
      if (!turn) fail('FORBIDDEN', 'Only the completed owning turn may propose memories.');
      const previous = this.store.one<{ results_json: string }>('SELECT results_json FROM turn_memory_batches WHERE turn_id=? AND owner_node_id=?', turnId, owner);
      if (previous) return JSON.parse(previous.results_json) as MemoryOutcome[];
      const outcomes = candidates.map(input => {
        try {
          return this.store.transaction(() => {
            const candidate = checkedMemory(memoryCandidateSchema, input);
            if (!turn.input_message_id || candidate.sourceMessageIds.some(id => id !== turn.input_message_id)) fail('FORBIDDEN', 'Candidate evidence was not the incoming message of this turn.');
            return this.propose(owner, candidate);
          });
        } catch (error) {
          if (!(error instanceof DmnError) || !['FORBIDDEN','VALIDATION'].includes(error.code)) throw error;
          this.event('memory.candidate_rejected', owner, null, error.code);
          return { status: 'rejected' as const, reason: error.code };
        }
      });
      this.store.run('INSERT INTO turn_memory_batches(turn_id,owner_node_id,results_json) VALUES(?,?,?)', turnId, owner, JSON.stringify(outcomes));
      return outcomes;
    });
  }

  /** Own related memories only. An empty hit set is legitimate; never pad with another owner. */
  forPrompt(trustedOwner: string, query: string) {
    const api = this.bindNode(trustedOwner);
    const identity = api.list({ kind: 'identity', limit: 3 }).filter(m => m.provenance === 'human');
    const related = query.trim() ? api.search({ query: query.slice(0, 256), limit: 5 }).filter(m => {
      if (m.kind === 'identity' || m.provenance !== 'candidate' || m.confidence < 0.7 || m.importance < 0.55 || !m.sourceMessageIds.length) return false;
      try { this.validateSources(trustedOwner, m.sourceMessageIds); return true; }
      catch (error) { if (error instanceof DmnError && error.code === 'FORBIDDEN') return false; throw error; }
    }) : [];
    return { identity, related };
  }

  private propose(owner: string, input: unknown): MemoryOutcome {
    rejectOwner(input);
    if (input && typeof input === 'object' && 'kind' in input && input.kind === 'identity') fail('FORBIDDEN', 'Ordinary nodes cannot propose identity changes.');
    const candidate = checkedMemory(memoryCandidateSchema, input);
    checkMemoryText(candidate.content);
    if (candidate.claimKey) checkMemoryText(candidate.claimKey);
    return this.store.transaction(() => {
      this.validateSources(owner, candidate.sourceMessageIds);
      const rejected = candidate.confidence < 0.7 ? 'LOW_CONFIDENCE' : candidate.importance < 0.55 ? 'LOW_IMPORTANCE' :
        candidate.kind === 'relationship' && !candidate.subjective ? 'RELATIONSHIP_MUST_BE_SUBJECTIVE' : undefined;
      if (rejected) { this.event('memory.candidate_rejected', owner, null, rejected); return { status: 'rejected', reason: rejected }; }
      const duplicate = this.store.one<Row>('SELECT * FROM memories WHERE owner_node_id=? AND kind=? AND content_key=? ORDER BY archived_at IS NOT NULL,rowid LIMIT 1', owner, candidate.kind, contentKey(candidate.content));
      if (duplicate) return duplicate.archived_at ? { status: 'rejected', reason: 'ARCHIVED' } : { status: 'duplicate', memoryId: duplicate.memory_id };
      const key = candidate.claimKey ? contentKey(candidate.claimKey) : null;
      const conflict = key ? this.store.one<Row>('SELECT * FROM memories WHERE owner_node_id=? AND kind=? AND claim_key=? AND archived_at IS NULL ORDER BY rowid LIMIT 1', owner, candidate.kind, key) : undefined;
      if (conflict) {
        const prior = this.store.one<{ candidate_id: string }>("SELECT candidate_id FROM memory_candidates WHERE owner_node_id=? AND memory_id=? AND candidate_json=? AND status='conflict'", owner, conflict.memory_id, JSON.stringify(candidate));
        if (prior) return { status: 'conflict', memoryId: conflict.memory_id, candidateId: prior.candidate_id };
        const candidateId = randomUUID();
        this.store.run("INSERT INTO memory_candidates VALUES(?,?,?,?,'conflict',?)", candidateId, owner, conflict.memory_id, JSON.stringify(candidate), this.now().toISOString());
        this.event('memory.conflict_pending', owner, conflict.memory_id);
        return { status: 'conflict', memoryId: conflict.memory_id, candidateId };
      }
      const memoryId = randomUUID();
      this.store.run(`INSERT INTO memories(memory_id,owner_node_id,kind,content,subjective,importance,confidence,source_message_ids_json,claim_key,content_key,created_at,updated_at,provenance)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'candidate')`, memoryId, owner, candidate.kind, candidate.content, Number(candidate.subjective), candidate.importance, candidate.confidence,
        JSON.stringify(candidate.sourceMessageIds), key, contentKey(candidate.content), this.now().toISOString(), this.now().toISOString());
      this.event('memory.accepted', owner, memoryId);
      return { status: 'accepted', memoryId };
    });
  }

  private list(owner: string, input: unknown) {
    const query = checkedMemory(listSchema, input);
    return this.store.all<Row>(`SELECT m.* FROM memories m WHERE m.owner_node_id=? AND m.archived_at IS NULL
      AND (? IS NULL OR m.kind=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(m.source_message_ids_json) s WHERE s.value=?))
      ORDER BY m.rowid DESC LIMIT ?`, owner, query.kind ?? null, query.kind ?? null, query.sourceMessageId ?? null, query.sourceMessageId ?? null, query.limit).map(record);
  }
  private search(owner: string, input: unknown): MemoryRecord[] {
    const query = checkedMemory(searchSchema, input);
    // Treat all user text as literal data, never as FTS operators or column selectors.
    const terms = searchTerms(query.query);
    const expression = terms.filter(term => [...term].length >= 3).map(term => `"${term.replaceAll('"','""')}"`).join(' OR ');
    if (expression) {
      return this.store.all<Row>(`SELECT m.* FROM memories_fts JOIN memories m ON m.rowid=memories_fts.rowid
        WHERE memories_fts MATCH ? AND m.owner_node_id=? AND m.archived_at IS NULL AND (? IS NULL OR m.kind=?)
        ORDER BY bm25(memories_fts),m.importance DESC,m.confidence DESC,m.rowid DESC LIMIT ?`, expression, owner, query.kind ?? null, query.kind ?? null, query.limit).map(record);
    }
    return this.store.all<Row>(`SELECT * FROM memories WHERE owner_node_id=? AND archived_at IS NULL AND (? IS NULL OR kind=?)
      AND instr(lower(content),lower(?))>0 ORDER BY importance DESC,confidence DESC,rowid DESC LIMIT ?`, owner, query.kind ?? null, query.kind ?? null, query.query, query.limit).map(record);
  }
  private sources(owner: string, memoryId: string) {
    const memory = this.own(owner, parseId(memoryId));
    return (JSON.parse(memory.source_message_ids_json) as string[]).map(id => {
      const source = this.store.one<{ id: string; topicId: string; from: string; to: string; content: string; createdAt: string }>(
        'SELECT message_id AS id,topic_id AS topicId,from_node AS "from",to_node AS "to",content,created_at AS createdAt FROM messages WHERE message_id=? AND (from_node=? OR to_node=?)', id, owner, owner);
      if (!source) fail('FORBIDDEN', 'Memory source is unavailable to this node.');
      return source;
    });
  }
  private revise(owner: string, input: unknown): MemoryRecord {
    const request = checkedMemory(revisionSchema, input);
    return this.store.transaction(() => {
      const prior = this.own(owner, request.memoryId); this.editable(prior, request.expectedVersion);
      if (prior.kind !== request.kind || (request.claimKey && contentKey(request.claimKey) !== prior.claim_key)) fail('FORBIDDEN', 'A revision cannot change memory kind or claim identity.');
      if (prior.kind === 'relationship' && !request.subjective) fail('VALIDATION', 'Relationship memories remain subjective.');
      this.validateSources(owner, request.sourceMessageIds);
      checkMemoryText(request.content); checkMemoryText(request.reason);
      return this.update(owner, prior, request, request.reason);
    });
  }
  private resolve(owner: string, input: unknown) {
    const request = checkedMemory(resolveSchema, input);
    return this.store.transaction(() => {
      const row = this.store.one<{ memory_id: string; candidate_json: string }>("SELECT * FROM memory_candidates WHERE candidate_id=? AND owner_node_id=? AND status='conflict'", request.candidateId, owner);
      if (!row) fail('FORBIDDEN', 'Conflict candidate is unavailable to this node.');
      const candidate = memoryCandidateSchema.parse(JSON.parse(row.candidate_json));
      const result = this.revise(owner, { ...candidate, memoryId: row.memory_id, expectedVersion: request.expectedVersion, reason: request.reason });
      this.store.run("UPDATE memory_candidates SET status='resolved' WHERE candidate_id=? AND owner_node_id=?", request.candidateId, owner);
      return result;
    });
  }
  private remove(owner: string, input: unknown, event = 'memory.deleted', identityAdmin = false) {
    const request = checkedMemory(deleteSchema, input);
    return this.store.transaction(() => {
      const prior = this.own(owner, request.memoryId);
      if (identityAdmin) {
        if (prior.kind !== 'identity') fail('FORBIDDEN', 'Identity management only targets Identity records.');
        if (prior.version !== request.expectedVersion) fail('CONFLICT', 'Identity revision is stale.');
      } else this.editable(prior, request.expectedVersion);
      checkMemoryText(request.reason);
      this.store.run('UPDATE memories SET archived_at=?,updated_at=?,version=version+1 WHERE memory_id=? AND owner_node_id=? AND version=?', this.now().toISOString(), this.now().toISOString(), prior.memory_id, owner, request.expectedVersion);
      const next = this.own(owner, prior.memory_id, true);
      this.revision(owner, prior, next, request.reason);
      this.event(event, owner, prior.memory_id);
      return { deleted: true, memoryId: prior.memory_id, version: next.version };
    });
  }
  private update(owner: string, prior: Row, input: { content: string; subjective: boolean; confidence: number; importance: number; sourceMessageIds: string[] }, reason: string) {
    this.store.run(`UPDATE memories SET content=?,subjective=?,confidence=?,importance=?,source_message_ids_json=?,content_key=?,updated_at=?,version=version+1,provenance=?
      WHERE memory_id=? AND owner_node_id=? AND version=?`, input.content, Number(input.subjective), input.confidence, input.importance, JSON.stringify(input.sourceMessageIds), contentKey(input.content), this.now().toISOString(), prior.kind === 'identity' ? 'human' : 'candidate', prior.memory_id, owner, prior.version);
    const next = this.own(owner, prior.memory_id);
    this.revision(owner, prior, next, reason); this.event('memory.revised', owner, prior.memory_id);
    return record(next);
  }
  private revision(owner: string, prior: Row, next: Row, reason: string) {
    if (prior.owner_node_id !== owner || next.owner_node_id !== owner) fail('FORBIDDEN', 'Revision owner mismatch.');
    this.store.run('INSERT INTO memory_revisions(revision_id,memory_id,prior_content,new_content,reason,revised_at,prior_json,new_json) VALUES(?,?,?,?,?,?,?,?)',
      randomUUID(), prior.memory_id, prior.content, next.content, reason, this.now().toISOString(), JSON.stringify(record(prior)), JSON.stringify(record(next)));
  }
  private editable(row: Row, expected: number) {
    if (row.kind === 'identity') fail('FORBIDDEN', 'Identity is managed only by the host.');
    if (row.version !== expected) fail('CONFLICT', 'Memory revision is stale.');
  }
  private own(owner: string, memoryId: string, includeArchived = false): Row {
    const row = this.store.one<Row>('SELECT * FROM memories WHERE owner_node_id=? AND memory_id=? AND (? OR archived_at IS NULL)', owner, memoryId, Number(includeArchived));
    if (!row) fail('FORBIDDEN', 'Memory is unavailable to this node.');
    return row;
  }
  private validateSources(owner: string, ids: string[]) {
    for (const id of ids) {
      if (!this.store.one('SELECT 1 FROM messages WHERE message_id=? AND (from_node=? OR to_node=?)', id, owner, owner)) fail('FORBIDDEN', 'Memory evidence is unavailable to this node.');
    }
  }
  private node(owner: string) {
    if (!this.store.one('SELECT 1 FROM model_nodes WHERE node_id=?', owner)) fail('FORBIDDEN', 'Memory owner is not registered.');
  }
  private event(type: string, owner: string, memoryId: string | null, reason?: string) {
    this.store.run('INSERT INTO events(event_type,node_id,payload_json,created_at) VALUES(?,?,?,?)', type, owner, JSON.stringify({ memoryId, ...(reason ? { reason } : {}) }), this.now().toISOString());
  }
}

function record(row: Row) {
  return { id: row.memory_id, ownerNodeId: row.owner_node_id, kind: row.kind, content: row.content, subjective: Boolean(row.subjective),
    confidence: row.confidence, importance: row.importance, sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    claimKey: row.claim_key, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at,
    provenance: row.provenance, evidenceStatus: row.provenance === 'human' ? 'human-reviewed' as const : row.provenance === 'legacy' ? 'legacy-unreviewed' as const : 'source-linked-unverified' as const };
}
function revisionSnapshot(json: string, content: string): Partial<MemoryRecord> & { content: string } {
  const parsed = JSON.parse(json) as Partial<MemoryRecord>;
  return typeof parsed.content === 'string' ? parsed as MemoryRecord : { content };
}
function searchTerms(query: string): string[] {
  const parts = query.normalize('NFKC').match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? [];
  const terms: string[] = [];
  for (const part of parts) {
    const chars = [...part];
    if (/\p{Script=Han}/u.test(part) && chars.length > 3) {
      for (let n = 0; n <= chars.length - 3 && terms.length < 16; n += 2) terms.push(chars.slice(n,n+3).join(''));
    } else terms.push(part);
    if (terms.length >= 16) break;
  }
  return [...new Set(terms)].slice(0,16);
}
