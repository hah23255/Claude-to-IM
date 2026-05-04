/**
 * Unit tests for v2 IM control commands: /run, /resume, /model, /restart.
 *
 * Drives bridge-manager._testOnly.handleCommand directly with a fake
 * adapter that captures outbound messages and an in-memory store.
 *
 * /run is intercepted earlier in handleMessage (before handleCommand), so
 * it is exercised via _testOnly.handleMessage instead.
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
  modelUpdates: Array<{ sessionId: string; model: string }> = [];
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

  listChannelBindings(channelType?: ChannelType) {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter(b => b.channelType === channelType) : all;
  }

  getSession(id: string) { return this.sessions.get(id) ?? null; }

  createSession(name: string, model: string, _sp?: string, cwd?: string) {
    // Use 40-char hex IDs so they pass validateSessionId (32-64 hex/UUID).
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
  updateSessionModel(sessionId: string, model: string) {
    this.modelUpdates.push({ sessionId, model });
  }
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
  private running = true;
  async start() {}
  async stop() {}
  isRunning() { return this.running; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true, messageId: `m-${this.sent.length}` };
  }
  validateConfig() { return null; }
  isAuthorized() { return true; }
}

class CapturingLLM implements LLMProvider {
  calls: StreamChatParams[] = [];
  streamChat(params: StreamChatParams): ReadableStream<string> {
    this.calls.push(params);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'ok' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}

const noopPerms: PermissionGateway = { resolvePendingPermission: () => true };
const noopLifecycle: LifecycleHooks = {};

function makeMsg(text: string, chatId = 'chat-1'): InboundMessage {
  return {
    messageId: 'msg-1',
    address: { channelType: 'telegram', chatId, displayName: 'Tester' },
    text,
    timestamp: Date.now(),
  };
}

function setupContext() {
  // Reset global state between tests
  delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];

  const store = new InMemoryStore();
  const llm = new CapturingLLM();
  initBridgeContext({ store, llm, permissions: noopPerms, lifecycle: noopLifecycle });
  return { store, llm };
}

function lastResponseText(adapter: FakeAdapter): string {
  const last = adapter.sent.at(-1);
  return last?.text ?? '';
}

// ── /model ──────────────────────────────────────────────────────

describe('/model command', () => {
  beforeEach(() => setupContext());

  it('rejects empty arg with usage hint', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await _testOnly.handleCommand(adapter, makeMsg('/model'), '/model');
    assert.match(lastResponseText(adapter), /Usage: \/model/);
  });

  it('rejects model name with shell metacharacters', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await _testOnly.handleCommand(adapter, makeMsg('/model bad name'), '/model bad name');
    assert.match(lastResponseText(adapter), /Invalid model name/);
  });

  it('updates the binding model when given a valid name', async () => {
    const mod = await import('../../lib/bridge/bridge-manager');
    const router = await import('../../lib/bridge/channel-router');
    const adapter = new FakeAdapter();
    const msg = makeMsg('/model claude-sonnet-4-7-20260514');
    // Resolve once to seed a binding so /model has something to update
    router.resolve(msg.address);
    await mod._testOnly.handleCommand(adapter, msg, '/model claude-sonnet-4-7-20260514');

    const updated = router.resolve(msg.address);
    assert.equal(updated.model, 'claude-sonnet-4-7-20260514');
    assert.match(lastResponseText(adapter), /Model set to/);
  });
});

// ── /restart ────────────────────────────────────────────────────

describe('/restart command', () => {
  beforeEach(() => setupContext());

  it('creates a new session while preserving cwd / mode / model', async () => {
    const mod = await import('../../lib/bridge/bridge-manager');
    const router = await import('../../lib/bridge/channel-router');
    const adapter = new FakeAdapter();
    const msg = makeMsg('/restart');

    const original = router.resolve(msg.address);
    router.updateBinding(original.id, {
      workingDirectory: '/tmp/projects/foo',
      mode: 'plan',
      model: 'claude-opus-4-7',
    });
    const beforeSessionId = router.resolve(msg.address).codepilotSessionId;

    await mod._testOnly.handleCommand(adapter, msg, '/restart');

    const after = router.resolve(msg.address);
    assert.notEqual(after.codepilotSessionId, beforeSessionId, 'session id should change');
    assert.equal(after.workingDirectory, '/tmp/projects/foo', 'cwd preserved');
    assert.equal(after.mode, 'plan', 'mode preserved');
    assert.equal(after.model, 'claude-opus-4-7', 'model preserved');
    assert.match(lastResponseText(adapter), /Session restarted/);
  });

  it('aborts an active task on the old session', async () => {
    const mod = await import('../../lib/bridge/bridge-manager');
    const router = await import('../../lib/bridge/channel-router');
    const adapter = new FakeAdapter();
    const msg = makeMsg('/restart');

    const original = router.resolve(msg.address);
    // Warm up bridge-manager global state by calling getStatus() (which calls
    // getState() internally). Without this, __bridge_manager__ is undefined.
    mod.getStatus();
    const state = (globalThis as unknown as Record<string, { activeTasks: Map<string, AbortController> }>)['__bridge_manager__'];
    const taskAbort = new AbortController();
    state.activeTasks.set(original.codepilotSessionId, taskAbort);

    await mod._testOnly.handleCommand(adapter, msg, '/restart');

    assert.ok(taskAbort.signal.aborted, 'task should be aborted');
    assert.equal(state.activeTasks.has(original.codepilotSessionId), false, 'old task should be removed');
  });
});

// ── /resume ─────────────────────────────────────────────────────

describe('/resume command', () => {
  beforeEach(() => setupContext());

  it('rejects empty arg', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await _testOnly.handleCommand(adapter, makeMsg('/resume'), '/resume');
    assert.match(lastResponseText(adapter), /Usage: \/resume/);
  });

  it('rejects malformed session id', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await _testOnly.handleCommand(adapter, makeMsg('/resume short'), '/resume short');
    assert.match(lastResponseText(adapter), /Invalid session ID format/);
  });

  it('reports "Session not found" when target session does not exist', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    const validId = 'a'.repeat(40);
    await _testOnly.handleCommand(adapter, makeMsg('/resume ' + validId), '/resume ' + validId);
    assert.match(lastResponseText(adapter), /Session not found/);
  });

  it('rebinds the chat to an existing session', async () => {
    const mod = await import('../../lib/bridge/bridge-manager');
    const router = await import('../../lib/bridge/channel-router');
    const adapter = new FakeAdapter();
    const msg = makeMsg('/resume');

    // Seed a target session in the store
    const ctxMod = await import('../../lib/bridge/context');
    const store = ctxMod.getBridgeContext().store as InMemoryStore;
    const target = store.createSession('seed', '', undefined, '/tmp/seed');

    // Seed an initial binding for this chat
    router.resolve(msg.address);

    await mod._testOnly.handleCommand(adapter, msg, '/resume ' + target.id);
    const rebound = router.resolve(msg.address);
    assert.equal(rebound.codepilotSessionId, target.id, 'binding should now point at the target session');
    assert.match(lastResponseText(adapter), /Resumed session/);
  });
});

// ── /run ────────────────────────────────────────────────────────

describe('/run command (handleMessage interception)', () => {
  beforeEach(() => setupContext());

  it('rejects empty arg with usage hint', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = new FakeAdapter();
    await _testOnly.handleMessage(adapter, makeMsg('/run'));
    assert.match(lastResponseText(adapter), /Usage: \/run/);
  });

  it('strips the prefix and invokes the LLM with the inner prompt', async () => {
    const mod = await import('../../lib/bridge/bridge-manager');
    const ctxMod = await import('../../lib/bridge/context');
    const adapter = new FakeAdapter();
    const llm = ctxMod.getBridgeContext().llm as CapturingLLM;

    await mod._testOnly.handleMessage(adapter, makeMsg('/run hello world'));

    assert.equal(llm.calls.length, 1, 'LLM should be called exactly once');
    assert.equal(llm.calls[0].prompt, 'hello world', 'prompt should have /run prefix stripped');
  });

  it('does not consume non-/run slash commands', async () => {
    const mod = await import('../../lib/bridge/bridge-manager');
    const ctxMod = await import('../../lib/bridge/context');
    const adapter = new FakeAdapter();
    const llm = ctxMod.getBridgeContext().llm as CapturingLLM;

    await mod._testOnly.handleMessage(adapter, makeMsg('/help'));

    assert.equal(llm.calls.length, 0, 'LLM should not be invoked for other slash commands');
    assert.match(lastResponseText(adapter), /CodePilot Bridge Commands/);
  });
});
