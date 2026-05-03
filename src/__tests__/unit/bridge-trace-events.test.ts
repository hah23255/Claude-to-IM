/**
 * Unit tests for the trace-event observability hook.
 *
 * The bridge emits TraceEvents via LifecycleHooks.onTraceEvent at key points
 * in message processing. These tests verify event ordering, shape, and
 * status-mapping for both the slash-command and LLM paths.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type {
  BridgeStore,
  LifecycleHooks,
  LLMProvider,
  PermissionGateway,
  StreamChatParams,
  BridgeSession,
  BridgeMessage,
  TraceEvent,
} from '../../lib/bridge/host';
import type {
  ChannelBinding,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../../lib/bridge/types';

// ── Fixtures ────────────────────────────────────────────────────

class InMemoryStore implements BridgeStore {
  settings = new Map<string, string>();
  sessions = new Map<string, BridgeSession>();
  bindings = new Map<string, ChannelBinding>();
  messages = new Map<string, BridgeMessage[]>();
  private nextId = 1;

  getSetting(key: string) { return this.settings.get(key) ?? null; }

  getChannelBinding(channelType: string, chatId: string) {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: {
    channelType: string;
    chatId: string;
    codepilotSessionId: string;
    sdkSessionId?: string;
    workingDirectory: string;
    model: string;
    mode?: string;
  }) {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const id = existing?.id || `binding-${this.nextId++}`;
    const binding: ChannelBinding = {
      id,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory ?? existing?.workingDirectory ?? '',
      model: data.model ?? existing?.model ?? '',
      mode: (data.mode as ChannelBinding['mode']) ?? existing?.mode ?? 'code',
      active: existing?.active ?? true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
    for (const [key, b] of this.bindings) {
      if (b.id === id) { this.bindings.set(key, { ...b, ...updates }); break; }
    }
  }

  listChannelBindings(_channelType?: ChannelType) {
    return Array.from(this.bindings.values());
  }

  getSession(id: string) { return this.sessions.get(id) ?? null; }

  createSession(_name: string, model: string, _sp?: string, cwd?: string) {
    // 40-char hex IDs to satisfy validateSessionId
    const seq = (this.nextId++).toString(16).padStart(8, '0');
    const id = `${seq}${'a'.repeat(32)}`.slice(0, 40);
    const session: BridgeSession = { id, working_directory: cwd || '/tmp', model };
    this.sessions.set(id, session);
    return session;
  }

  updateSessionProviderId() {}
  addMessage(sessionId: string, role: string, content: string) {
    const msgs = this.messages.get(sessionId) || [];
    msgs.push({ role, content });
    this.messages.set(sessionId, msgs);
  }
  getMessages(sessionId: string) { return { messages: this.messages.get(sessionId) || [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSdkSessionId() {}
  updateSessionModel() {}
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset() {}
}

class FakeAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram';
  sent: OutboundMessage[] = [];
  async start() {}
  async stop() {}
  isRunning() { return true; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true, messageId: `out-${this.sent.length}` };
  }
  validateConfig() { return null; }
  isAuthorized() { return true; }
}

class EchoLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const text = `Echo: ${params.prompt}`;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}

const noopPerms: PermissionGateway = { resolvePendingPermission: () => true };

function makeMsg(text: string, chatId = 'chat-1', messageId = 'msg-1'): InboundMessage {
  return {
    messageId,
    address: { channelType: 'telegram', chatId, displayName: 'Tester' },
    text,
    timestamp: Date.now(),
  };
}

function setup() {
  delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];

  const captured: TraceEvent[] = [];
  const lifecycle: LifecycleHooks = {
    onTraceEvent(e) { captured.push(e); },
  };
  initBridgeContext({
    store: new InMemoryStore(),
    llm: new EchoLLM(),
    permissions: noopPerms,
    lifecycle,
  });
  return { captured };
}

// ── Slash-command path ──────────────────────────────────────────

describe('trace events - slash command path', () => {
  beforeEach(() => setup());

  it('emits message-start, command-dispatch, message-end for /help', async () => {
    const { captured } = setup();
    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await mod._testOnly.handleMessage(adapter, makeMsg('/help'));

    const types = captured.map(e => e.type);
    assert.deepStrictEqual(types, ['message-start', 'command-dispatch', 'message-end']);

    const start = captured[0] as Extract<TraceEvent, { type: 'message-start' }>;
    assert.equal(start.messageId, 'msg-1');
    assert.equal(start.channelType, 'telegram');
    assert.equal(start.chatId, 'chat-1');
    assert.equal(start.hasAttachments, false);
    assert.equal(start.textLength, 5);

    const dispatch = captured[1] as Extract<TraceEvent, { type: 'command-dispatch' }>;
    assert.equal(dispatch.command, '/help');
    assert.equal(dispatch.hasArgs, false);

    const end = captured[2] as Extract<TraceEvent, { type: 'message-end' }>;
    assert.equal(end.messageId, 'msg-1');
    assert.equal(end.status, 'command-only');
    assert.ok(end.durationMs >= 0);
  });

  it('flags hasArgs:true for commands with arguments', async () => {
    const { captured } = setup();
    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await mod._testOnly.handleMessage(adapter, makeMsg('/cwd /tmp/foo'));

    const dispatch = captured.find(e => e.type === 'command-dispatch') as Extract<TraceEvent, { type: 'command-dispatch' }>;
    assert.equal(dispatch.command, '/cwd');
    assert.equal(dispatch.hasArgs, true);
  });

  it('strips @bot suffix from command name', async () => {
    const { captured } = setup();
    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await mod._testOnly.handleMessage(adapter, makeMsg('/help@MyBot'));

    const dispatch = captured.find(e => e.type === 'command-dispatch') as Extract<TraceEvent, { type: 'command-dispatch' }>;
    assert.equal(dispatch.command, '/help');
  });
});

// ── LLM path ────────────────────────────────────────────────────

describe('trace events - LLM path', () => {
  beforeEach(() => setup());

  it('emits the full lifecycle for a regular message', async () => {
    const { captured } = setup();
    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await mod._testOnly.handleMessage(adapter, makeMsg('hello world'));

    const types = captured.map(e => e.type);
    assert.deepStrictEqual(
      types,
      ['message-start', 'llm-stream-start', 'llm-stream-end', 'delivery', 'message-end'],
      `expected full lifecycle, got: ${types.join(', ')}`,
    );

    const start = captured[0] as Extract<TraceEvent, { type: 'message-start' }>;
    assert.equal(start.textLength, 11);

    const llmStart = captured[1] as Extract<TraceEvent, { type: 'llm-stream-start' }>;
    assert.equal(llmStart.promptLength, 11);

    const llmEnd = captured[2] as Extract<TraceEvent, { type: 'llm-stream-end' }>;
    assert.equal(llmEnd.status, 'ok');
    assert.equal(llmEnd.toolUseCount, 0);
    assert.equal(llmEnd.responseLength, 'Echo: hello world'.length);
    assert.deepStrictEqual(llmEnd.tokenUsage, { input_tokens: 10, output_tokens: 5 });

    const delivery = captured[3] as Extract<TraceEvent, { type: 'delivery' }>;
    assert.equal(delivery.status, 'ok');
    assert.equal(delivery.channelType, 'telegram');
    assert.ok(delivery.bytesDelivered > 0);

    const end = captured[4] as Extract<TraceEvent, { type: 'message-end' }>;
    assert.equal(end.status, 'ok');
    assert.ok(end.durationMs >= 0);
  });

  it('all events for one message share the same messageId', async () => {
    const { captured } = setup();
    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await mod._testOnly.handleMessage(adapter, makeMsg('test', 'chat-1', 'msg-xyz'));

    for (const e of captured) {
      assert.equal(e.messageId, 'msg-xyz', `event ${e.type} had wrong messageId`);
    }
  });

  it('strips /run prefix; promptLength reflects inner text only', async () => {
    const { captured } = setup();
    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await mod._testOnly.handleMessage(adapter, makeMsg('/run hello there'));

    const llmStart = captured.find(e => e.type === 'llm-stream-start') as Extract<TraceEvent, { type: 'llm-stream-start' }>;
    assert.ok(llmStart, 'expected llm-stream-start to fire');
    assert.equal(llmStart.promptLength, 'hello there'.length);
  });
});

// ── Robustness ──────────────────────────────────────────────────

describe('trace events - robustness', () => {
  beforeEach(() => setup());

  it('does not break message processing when onTraceEvent throws', async () => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];

    initBridgeContext({
      store: new InMemoryStore(),
      llm: new EchoLLM(),
      permissions: noopPerms,
      lifecycle: {
        onTraceEvent() { throw new Error('host bug'); },
      },
    });

    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    // If trace errors propagated, this would throw and the test would fail.
    await mod._testOnly.handleMessage(adapter, makeMsg('hello'));
    assert.ok(adapter.sent.length > 0, 'message should still have been delivered');
  });

  it('emits no events when host has no onTraceEvent hook', async () => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];

    initBridgeContext({
      store: new InMemoryStore(),
      llm: new EchoLLM(),
      permissions: noopPerms,
      lifecycle: {}, // no onTraceEvent
    });

    const mod = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    // Should complete without error and without any side-effects related to tracing.
    await mod._testOnly.handleMessage(adapter, makeMsg('hello'));
    assert.ok(adapter.sent.length > 0);
  });
});
