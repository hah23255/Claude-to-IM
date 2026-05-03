# CipherClaw integration (pilot)

Wire the bridge's trace events into [CipherClaw](https://github.com/Alexi5000/CipherClaw)
for autonomous debug graph construction, drift detection, and predictive failure
analysis on your IM-driven Claude sessions.

This is a **pilot pattern** — the bridge has zero compile-time dependency on
CipherClaw. The integration lives entirely in the host application that sets up
the bridge context.

## What you get

- A causal DAG per inbound message — see exactly which sub-step failed.
- Cognitive fingerprint per session — detect when an agent's behavior shifts.
- Anomaly cascade detection across messages — catch crashloops early.
- Predicted failure types with confidence scores — surface in your IM if you want.

## What the bridge emits

The bridge's `LifecycleHooks.onTraceEvent` fires the following events per inbound
message (see [`src/lib/bridge/host.ts`](../../src/lib/bridge/host.ts) for full
type definitions):

| Event | When | Key fields |
|---|---|---|
| `message-start` | Right after early-return shortcuts (callbacks, attachment failures) pass | `messageId`, `sessionId`, `channelType`, `chatId`, `hasAttachments`, `textLength` |
| `command-dispatch` | Before `handleCommand` runs (slash commands only) | `command` (canonical, e.g. `/help`), `hasArgs` |
| `llm-stream-start` | Just before `LLMProvider.streamChat()` | `model`, `promptLength` |
| `llm-stream-end` | After SSE stream consumption completes | `durationMs`, `status`, `tokenUsage`, `toolUseCount`, `responseLength`, `errorMessage?` |
| `delivery` | After `deliverResponse()` returns | `channelType`, `durationMs`, `status`, `bytesDelivered` |
| `message-end` | Always — once per inbound message in the `finally` block | `durationMs`, `status` (`ok` / `error` / `aborted` / `command-only`), `errorMessage?` |

All events for one message share the same `messageId`. Errors thrown from your
`onTraceEvent` handler are caught and logged — they will never break message
handling.

## Setup

### 1. Install CipherClaw in your host application

```bash
npm install cipherclaw
# or
pnpm add cipherclaw
```

The bridge itself stays dependency-free — only your host needs CipherClaw.

### 2. Drop in the adapter

Save this as `src/cipherclaw-bridge.ts` (or wherever your host code lives):

```typescript
import { createCipherClaw, type DebugSession } from 'cipherclaw';
import type { LifecycleHooks, TraceEvent } from 'claude-to-im/host';

interface InFlightTrace {
  sessionId: string;
  rootSpanId: string;
  startTime: number;
  spans: Array<{
    id: string;
    name: string;
    category: string;
    startTime: number;
    endTime?: number;
    parentSpanId: string | null;
    status: 'ok' | 'error';
    attributes: Record<string, unknown>;
  }>;
}

export function createCipherClawLifecycle(opts?: {
  domain?: 'agent' | 'crm' | 'content' | 'infrastructure';
  maxTraces?: number;
  onPrediction?: (p: { type: string; confidence: number; sessionId: string }) => void;
}): LifecycleHooks {
  const cc = createCipherClaw({
    maxTraces: opts?.maxTraces ?? 5000,
    enableSelfDebug: true,
    enableHierarchyPropagation: true,
  });

  let bridgeSession: DebugSession | undefined;
  const inFlight = new Map<string, InFlightTrace>();

  return {
    onBridgeStart() {
      bridgeSession = cc.startSession({ domain: opts?.domain ?? 'agent' });
    },

    onBridgeStop() {
      if (bridgeSession) cc.completeSession(bridgeSession.id);
    },

    onTraceEvent(event: TraceEvent) {
      switch (event.type) {
        case 'message-start': {
          const rootSpanId = `root-${event.messageId}`;
          inFlight.set(event.messageId, {
            sessionId: event.sessionId,
            rootSpanId,
            startTime: event.ts,
            spans: [{
              id: rootSpanId,
              name: 'bridge.handle_message',
              category: 'orchestration',
              startTime: event.ts,
              parentSpanId: null,
              status: 'ok',
              attributes: {
                channelType: event.channelType,
                chatId: event.chatId,
                hasAttachments: event.hasAttachments,
                textLength: event.textLength,
              },
            }],
          });
          break;
        }

        case 'command-dispatch': {
          const trace = inFlight.get(event.messageId);
          if (!trace) break;
          trace.spans.push({
            id: `cmd-${event.messageId}`,
            name: `bridge.command.${event.command.replace(/^\//, '')}`,
            category: 'action',
            startTime: event.ts,
            endTime: event.ts,
            parentSpanId: trace.rootSpanId,
            status: 'ok',
            attributes: { command: event.command, hasArgs: event.hasArgs },
          });
          break;
        }

        case 'llm-stream-start': {
          const trace = inFlight.get(event.messageId);
          if (!trace) break;
          trace.spans.push({
            id: `llm-${event.messageId}`,
            name: 'llm.stream_chat',
            category: 'inference',
            startTime: event.ts,
            parentSpanId: trace.rootSpanId,
            status: 'ok',
            attributes: { model: event.model, promptLength: event.promptLength },
          });
          break;
        }

        case 'llm-stream-end': {
          const trace = inFlight.get(event.messageId);
          if (!trace) break;
          const llmSpan = trace.spans.find(s => s.id === `llm-${event.messageId}`);
          if (llmSpan) {
            llmSpan.endTime = event.ts;
            llmSpan.status = event.status;
            llmSpan.attributes = {
              ...llmSpan.attributes,
              durationMs: event.durationMs,
              toolUseCount: event.toolUseCount,
              responseLength: event.responseLength,
              inputTokens: event.tokenUsage?.input_tokens,
              outputTokens: event.tokenUsage?.output_tokens,
              ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
            };
          }
          break;
        }

        case 'delivery': {
          const trace = inFlight.get(event.messageId);
          if (!trace) break;
          trace.spans.push({
            id: `del-${event.messageId}`,
            name: 'bridge.deliver_response',
            category: 'action',
            startTime: event.ts - event.durationMs,
            endTime: event.ts,
            parentSpanId: trace.rootSpanId,
            status: event.status,
            attributes: {
              channelType: event.channelType,
              bytesDelivered: event.bytesDelivered,
              durationMs: event.durationMs,
            },
          });
          break;
        }

        case 'message-end': {
          const trace = inFlight.get(event.messageId);
          if (!trace) break;
          const root = trace.spans.find(s => s.id === trace.rootSpanId);
          if (root) {
            root.endTime = event.ts;
            root.status =
              event.status === 'ok' || event.status === 'command-only' ? 'ok' : 'error';
            root.attributes = {
              ...root.attributes,
              outcome: event.status,
              durationMs: event.durationMs,
              ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
            };
          }

          const traceId = `trace-${event.messageId}`;
          cc.ingestTrace({
            id: traceId,
            sessionId: bridgeSession?.id ?? 'orphan',
            rootSpanId: trace.rootSpanId,
            agentId: `bridge-${event.sessionId.slice(0, 8) || 'no-binding'}`,
            domain: opts?.domain ?? 'agent',
            startTime: trace.startTime,
            endTime: event.ts,
            durationMs: event.durationMs,
            status: event.status === 'ok' || event.status === 'command-only' ? 'ok' : 'error',
            totalTokens: 0,
            totalCost: 0,
            spans: trace.spans.map(s => ({
              id: s.id,
              traceId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              // CipherClaw expects one of its categories — cast through unknown
              // because the bridge categories don't directly map.
              category: s.category as unknown as 'orchestration',
              startTime: s.startTime,
              endTime: s.endTime ?? event.ts,
              durationMs: (s.endTime ?? event.ts) - s.startTime,
              status: s.status,
              agentId: `bridge-${event.sessionId.slice(0, 8) || 'no-binding'}`,
              domain: opts?.domain ?? 'agent',
              attributes: s.attributes,
              events: [],
            })),
          });
          inFlight.delete(event.messageId);

          // Surface predictions to the host (e.g. notify ops on Telegram).
          if (opts?.onPrediction && bridgeSession) {
            const predictions = cc.getPredictions(bridgeSession.id);
            for (const p of predictions) {
              opts.onPrediction({
                type: p.predictedFailureType,
                confidence: p.confidence,
                sessionId: bridgeSession.id,
              });
            }
          }
          break;
        }
      }
    },
  };
}
```

### 3. Wire it into the bridge context

```typescript
import { initBridgeContext } from 'claude-to-im';
import * as bridgeManager from 'claude-to-im/bridge-manager';
import { createCipherClawLifecycle } from './cipherclaw-bridge.js';

initBridgeContext({
  store: yourBridgeStore,
  llm: yourLLMProvider,
  permissions: yourPermissionGateway,
  lifecycle: createCipherClawLifecycle({
    domain: 'agent',
    maxTraces: 5000,
    onPrediction: (p) => {
      // Forward predictions back to the IM if you like:
      console.log(`[cipherclaw] ${p.type} predicted, confidence=${(p.confidence * 100).toFixed(0)}%`);
    },
  }),
});

await bridgeManager.start();
```

That's it. Every inbound message now becomes a CipherClaw trace.

## Pilot recommendations

- **Cap session length.** CipherClaw stores all traces in-memory. A long-running
  bridge with no rotation will grow unbounded. Call `cc.completeSession()` and
  `cc.startSession()` periodically (e.g. hourly) — the example above does this
  per `onBridgeStart` / `onBridgeStop` only.
- **Start small.** Run against one IM channel first. Check the causal graphs and
  drift detection actually surface signal vs. noise on your traffic before
  expanding.
- **Don't trust the "predictive" framing literally.** CipherClaw's predictive
  engine is present-tense pattern matching, not time-series forecasting —
  treat predictions as anomaly hints, not crystal-ball outputs.
- **Map domains by use-case.** If your bridge serves a CRM-style agent, set
  `domain: 'crm'`. The cross-domain correlation feature only fires when you
  feed multiple domains.

## Limitations (current pilot scope)

- Tool-use spans are **summarised, not individually traced**. The bridge emits
  `toolUseCount` on `llm-stream-end` rather than per-tool spans. If you need
  per-tool granularity, it's a small extension to `conversation-engine.ts`'s
  `consumeStream` to emit `tool-use` / `tool-result` trace events.
- Permission flow events are **not traced**. Permission requests cross multiple
  inbound messages (request → user reply → resolve), which doesn't map cleanly
  to a single per-message trace. A follow-up could add `permission-request` /
  `permission-resolution` events with their own correlation IDs.
- Streaming preview events (the per-character preview drafts) are **not traced**
  to keep volume sane — usually you want one span per LLM stream, not per chunk.

See [CipherClaw#technical-debt](https://github.com/Alexi5000/CipherClaw) for
known upstream limitations (in-memory storage cap, fixed 128k token assumption,
hardcoded thresholds).
