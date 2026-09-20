import { z } from 'zod';
import { apiBase, hash, identifier, MAX_PENDING, MAX_RECORDS, MAX_SEEN, MAX_TEXT_BYTES, SafeError } from './common.js';
import { isChannelResourceUri } from './resourceUri.js';
import { closingResults, type DeliveryResult } from './messageEvents.js';

const bytes = (max: number) => z.string().refine(s => s.isWellFormed() && Buffer.byteLength(s) <= max);
const id = z.string().refine(identifier);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const bindingSchema = z.object({
  hostId: bytes(512).regex(/^Code(?: - Insiders)?:[\w:.-]+$/),
  session: z.string().refine(isChannelResourceUri),
  chat: z.string().refine(isChannelResourceUri),
  // Legacy journal discriminator, not a workspace authorization requirement.
  workspace: digest.optional(),
}).strict();
export type Binding = z.infer<typeof bindingSchema>;

export function parseBinding(value: unknown): Binding {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path[0])
      .filter(field => field === 'hostId' || field === 'session' || field === 'chat' || field === 'workspace'))];
    throw new SafeError(`Invalid binding${fields.length ? ` (${fields.join(', ')})` : ''}. Select the exact Host-provided session/chat again. Resource URIs cannot contain credentials, query parameters or fragments.`);
  }
  return parsed.data;
}
export const credentialsSchema = z.object({
  botId: id, ownerId: id,
  token: bytes(8192).min(1).refine(s => !/[\r\n]/.test(s)),
  base: z.string().transform(apiBase),
}).strict().refine(s => s.botId !== s.ownerId);
export type Credentials = z.infer<typeof credentialsSchema>;

const messageSchema = z.object({
  id: digest,
  messageId: id,
  text: bytes(MAX_TEXT_BYTES),
  contextToken: bytes(8192),
  binding: digest,
  receivedAt: z.number().finite(),
  updatedAt: z.number().finite().optional(),
  delivery: z.enum(['received', 'dispatching', 'accepted', 'ambiguous', 'closed']),
  turnId: z.string().uuid().optional(),
  queueId: z.string().uuid().optional(),
  outbound: z.object({
    digest, sent: z.number().int().min(0).max(16),
    status: z.enum(['sending', 'sent', 'uncertain']),
  }).strict().optional(),
}).strict();
const currentMessageSchema = messageSchema.extend({ resultRecorded: z.boolean().optional() });
export type StoredMessage = z.infer<typeof currentMessageSchema>;
const legacyStateSchema = z.object({
  version: z.literal(1),
  credentials: credentialsSchema,
  cursor: bytes(64 * 1024),
  seen: z.array(digest).max(MAX_SEEN),
  messages: z.array(messageSchema).max(MAX_RECORDS),
}).strict().refine(s => s.messages.filter(m => m.delivery !== 'closed' && m.outbound?.status !== 'sent').length <= MAX_PENDING);
const routeSchema = z.object({ contextToken: bytes(8192).min(1) }).strict();
export type ReplyRoute = z.infer<typeof routeSchema>;
const syncTurnSchema = z.object({
  sourceId: id,
  turnId: id.optional(),
  queueId: id.optional(),
  requestId: digest.optional(),
  route: routeSchema.optional(),
  complete: z.boolean(),
}).strict();
const currentTurnSchema = syncTurnSchema.extend({ completionRecorded: z.boolean().optional() });
export type SyncTurn = z.infer<typeof currentTurnSchema>;
const outgoingSchema = z.object({
  id: digest,
  binding: digest,
  runId: z.string().uuid(),
  sourceId: id,
  role: z.enum(['user', 'assistant']),
  text: bytes(MAX_TEXT_BYTES),
  route: routeSchema.optional(),
  status: z.enum(['waiting', 'pending', 'sending', 'sent', 'uncertain', 'cancelled']),
  sent: z.number().int().min(0).max(16),
  parts: z.array(bytes(3500).min(1)).max(16).optional(),
  createdAt: z.number().finite().optional(),
  updatedAt: z.number().finite().optional(),
}).strict();
const currentOutgoingSchema = outgoingSchema.extend({
  role: z.enum(['user', 'assistant', 'status']),
  resultRecorded: z.boolean().optional(),
});
export type OutgoingText = z.infer<typeof currentOutgoingSchema>;
const versionTwoSchema = z.object({
  version: z.literal(2),
  credentials: credentialsSchema,
  cursor: bytes(64 * 1024),
  seen: z.array(digest).max(MAX_SEEN),
  messages: z.array(messageSchema).max(MAX_RECORDS),
  peer: z.object({ binding: digest, contextToken: bytes(8192).min(1) }).strict().optional(),
  sync: z.object({
    binding: digest, runId: z.string().uuid(),
    turns: z.array(syncTurnSchema).max(128),
    seen: z.array(digest).max(MAX_SEEN),
  }).strict().optional(),
  outbox: z.array(outgoingSchema).max(256),
}).strict();
const stateSchema = versionTwoSchema.extend({
  version: z.literal(3),
  messages: z.array(currentMessageSchema).max(MAX_RECORDS),
  sync: z.object({
    binding: digest, runId: z.string().uuid(),
    turns: z.array(currentTurnSchema).max(128),
    seen: z.array(digest).max(MAX_SEEN),
    waiting: z.object({ episodeId: z.string().uuid(), turnId: id.optional(), notified: z.boolean() }).strict().optional(),
  }).strict().optional(),
  outbox: z.array(currentOutgoingSchema).max(272),
}).strict().refine(s => s.messages.filter(m => m.delivery !== 'closed' && m.outbound?.status !== 'sent').length <= MAX_PENDING
  && s.outbox.filter(entry => entry.role !== 'status').length <= 256
  && s.outbox.filter(entry => entry.role === 'status').length <= 16);
export type PrivateState = z.infer<typeof stateSchema>;

export interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export const SECRET_KEY = 'wechat-ahp.private.v1';

export function bindingKey(binding: Binding): string {
  return hash(JSON.stringify([binding.hostId, binding.session, binding.chat, binding.workspace]));
}

export function newState(credentials: Credentials): PrivateState {
  return parseState({ version: 3, credentials, cursor: '', seen: [], messages: [], outbox: [] });
}

function parseState(value: unknown): PrivateState {
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 1) {
    const legacy = legacyStateSchema.safeParse(value);
    if (!legacy.success) throw new SafeError('Invalid legacy private channel state; credentials and journal were not overwritten.');
    value = { ...legacy.data, version: 2, outbox: [] };
  }
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 2) {
    const legacy = versionTwoSchema.safeParse(value);
    if (!legacy.success) throw new SafeError('Invalid v2 private channel state; credentials and journal were not overwritten.');
    value = {
      ...legacy.data, version: 3,
      messages: legacy.data.messages.map(message => ({
        ...message, resultRecorded: message.delivery === 'accepted' || message.delivery === 'closed' || !!message.outbound,
      })),
      outbox: legacy.data.outbox.map(entry => ({
        ...entry, resultRecorded: ['sent', 'uncertain', 'cancelled'].includes(entry.status),
      })),
    };
  }
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new SafeError('Invalid private channel state. Polling stopped; preserve SecretStorage for recovery.');
  return parsed.data;
}

export class Vault {
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly secrets: Secrets, private state: PrivateState) {}

  static async load(secrets: Secrets): Promise<Vault | undefined> {
    let raw: string | undefined;
    try { raw = await secrets.get(SECRET_KEY); }
    catch { throw new SafeError('Cannot read VS Code SecretStorage. Unlock your OS credential store (Keychain or desktop keyring) and retry.'); }
    if (raw === undefined) return undefined;
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new SafeError('Private channel state exceeds its 2 MiB bound.');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new SafeError('Private channel state is corrupt; not overwritten.'); }
    return new Vault(secrets, parseState(value));
  }

  static async create(secrets: Secrets, credentials: Credentials): Promise<Vault> {
    const vault = new Vault(secrets, newState(credentials));
    await vault.update(() => undefined);
    return vault;
  }

  snapshot(): PrivateState { return structuredClone(this.state); }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(mutator: (draft: PrivateState) => void): Promise<void> {
    const work = this.tail.then(async () => {
      const next = structuredClone(this.state);
      mutator(next);
      const parsed = parseState(next);
      const data = JSON.stringify(parsed);
      if (Buffer.byteLength(data) > 2 * 1024 * 1024) {
        throw new SafeError('Private journal is full (2 MiB). No messages or cursor were discarded.');
      }
      try { await this.secrets.store(SECRET_KEY, data); }
      catch { throw new SafeError('SecretStorage write failed. Channel stopped before advancing its cursor.', false, 'storage'); }
      this.state = parsed;
      for (const listener of this.listeners) listener();
    });
    // Each caller receives its failure; the serialization gate is usable after it.
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  async invalidateReplies(binding: string): Promise<DeliveryResult[]> {
    let results: DeliveryResult[] = [];
    await this.update(next => {
      results = closingResults(next, binding);
      for (const message of next.messages) {
        if (message.binding !== binding) continue;
        if (message.outbound?.status === 'sending') message.outbound.status = 'uncertain';
        if (message.delivery === 'accepted') {
          message.delivery = 'closed';
          message.text = '';
          message.contextToken = '';
        }
      }
      for (const outgoing of next.outbox) {
        if (outgoing.binding !== binding) continue;
        if (outgoing.status === 'sending') outgoing.status = 'uncertain';
        if (outgoing.status === 'pending' || outgoing.status === 'waiting') outgoing.status = 'cancelled';
        outgoing.text = '';
        outgoing.route = undefined;
        outgoing.parts = undefined;
        outgoing.updatedAt = Date.now();
      }
      if (next.sync?.binding === binding) next.sync = undefined;
    });
    return results;
  }
}
