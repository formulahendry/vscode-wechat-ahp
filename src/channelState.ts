import { SessionStatus } from '@microsoft/agent-host-protocol';
import { bindingKey, type Binding, type PrivateState } from './storage.js';
import { hash } from './common.js';

export type AgentStatus = 'Unknown' | 'Idle' | 'Busy' | 'Awaiting input' | 'Error';
export interface RuntimeHealth {
  receive?: string;
  agent?: AgentStatus;
  lastPollAt?: string;
  account?: 'Sign-in required';
}
export interface DeliverySummary {
  id: string;
  direction: 'WeChat -> VS Code' | 'VS Code -> WeChat';
  role: 'User' | 'Assistant' | 'Status';
  status: string;
  time?: number;
  confirmedParts?: number;
}
export interface ChannelState {
  phase: string;
  account: 'Signed out' | 'Signed in' | 'Sign-in required' | 'Unavailable';
  ownerAlias?: string;
  binding?: Binding;
  active: boolean;
  busy: boolean;
  trusted: boolean;
  receive: string;
  agent: AgentStatus;
  peerReady: boolean;
  pendingInbound: number;
  waiting: number;
  pending: number;
  sending: number;
  uncertain: number;
  recent: DeliverySummary[];
  lastActivity?: number;
  lastPollAt?: string;
  lastError?: string;
}

export function initialChannelState(): ChannelState {
  return {
    phase: 'Disconnected', account: 'Signed out', active: false, busy: false, trusted: false,
    receive: 'Stopped', agent: 'Unknown', peerReady: false,
    pendingInbound: 0, waiting: 0, pending: 0, sending: 0, uncertain: 0, recent: [],
  };
}

export function agentStatus(status: number): AgentStatus {
  if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) return 'Awaiting input';
  if (status & SessionStatus.InProgress) return 'Busy';
  if (status & SessionStatus.Error) return 'Error';
  if (status & SessionStatus.Idle) return 'Idle';
  return 'Unknown';
}

export function privateSummary(state: PrivateState | undefined, binding?: Binding): Pick<ChannelState,
  'account' | 'ownerAlias' | 'peerReady' | 'pendingInbound' | 'waiting' | 'pending' | 'sending' | 'uncertain' | 'recent' | 'lastActivity'> {
  const key = binding ? bindingKey(binding) : undefined;
  const messages = state?.messages.filter(message => message.binding === key) ?? [];
  const outbox = state?.outbox.filter(entry => entry.binding === key) ?? [];
  const recent: DeliverySummary[] = [
    ...messages.map(message => ({
      id: `in-${message.id}`, direction: 'WeChat -> VS Code' as const, role: 'User' as const,
      status: message.delivery === 'accepted' ? 'Host accepted' : message.delivery === 'closed' ? 'Closed' : message.delivery,
      time: message.updatedAt ?? message.receivedAt,
    })),
    ...outbox.map(entry => ({
      id: `out-${entry.id}`, direction: 'VS Code -> WeChat' as const,
      role: entry.role === 'user' ? 'User' as const : entry.role === 'status' ? 'Status' as const : 'Assistant' as const,
      status: entry.status === 'sent' ? 'API accepted (not a read receipt)' : entry.status,
      time: entry.updatedAt ?? entry.createdAt, confirmedParts: entry.sent,
    })),
  ].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 30);
  return {
    account: state ? 'Signed in' : 'Signed out',
    ownerAlias: state ? hash(state.credentials.ownerId).slice(0, 8) : undefined,
    peerReady: !!key && state?.peer?.binding === key,
    pendingInbound: messages.filter(message => message.delivery === 'received' || message.delivery === 'dispatching' || message.delivery === 'ambiguous').length,
    waiting: outbox.filter(entry => entry.status === 'waiting').length,
    pending: outbox.filter(entry => entry.status === 'pending').length,
    sending: outbox.filter(entry => entry.status === 'sending').length,
    uncertain: outbox.filter(entry => entry.status === 'uncertain').length
      + messages.filter(message => message.outbound?.status === 'uncertain' || message.outbound?.status === 'sending').length,
    recent, lastActivity: recent[0]?.time,
  };
}

export function sendStatus(state: ChannelState): string {
  if (state.uncertain) return `Uncertain delivery (${state.uncertain})`;
  if (state.sending) return `Sending (${state.sending})`;
  if (!state.active) return 'Stopped';
  if (!state.peerReady || state.waiting) return 'Waiting for a WeChat message';
  if (state.pending) return `Queued (${state.pending})`;
  return 'Ready';
}
