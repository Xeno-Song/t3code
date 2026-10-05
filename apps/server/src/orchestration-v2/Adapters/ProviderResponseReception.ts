import * as NodeBuffer from "node:buffer";
import type { OrchestrationV2ResponseReception } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface ProviderResponseReception {
  readonly current: OrchestrationV2ResponseReception;
  readonly append: (itemId: string, delta: string) => Effect.Effect<void>;
  readonly observeSnapshot: (itemId: string, text: string) => Effect.Effect<void>;
  readonly observeOutputTokens: (usageId: string, tokens: number) => Effect.Effect<void>;
  readonly startTool: (toolId: string) => Effect.Effect<void>;
  readonly endTool: (toolId: string) => Effect.Effect<void>;
  readonly finish: (
    reportedOutputTokens?: number,
  ) => Effect.Effect<OrchestrationV2ResponseReception>;
}

/** Tracks unique text, coalescing metadata independently of the text stream. */
export const makeProviderResponseReception = Effect.fnUntraced(function* (input: {
  readonly startedAt?: DateTime.Utc;
  readonly emit: (reception: OrchestrationV2ResponseReception) => Effect.Effect<void>;
}): Effect.fn.Return<ProviderResponseReception, never, Scope.Scope> {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const lock = yield* Semaphore.make(1);
  const items = new Map<string, { streamBytes: number; snapshotBytes: number }>();
  const outputUsage = new Map<string, number>();
  const tools = new Map<string, boolean>();
  let activeTools = 0;
  const startedAt = input.startedAt ?? (yield* DateTime.now);
  let reception: OrchestrationV2ResponseReception = {
    receivedTextBytes: 0,
    outputTokens: null,
    providerWaitMs: 0,
    providerWaitStartedAt: DateTime.formatIso(startedAt),
    firstTextReceivedAt: null,
    lastTextReceivedAt: null,
  };
  let scheduled = false;
  let closed = false;
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      closed = true;
      items.clear();
      outputUsage.clear();
      tools.clear();
    }),
  );

  // Called under the lock by both text and usage reports.
  const scheduleUpdate = Effect.gen(function* () {
    if (scheduled) return;
    scheduled = true;
    yield* Effect.sleep("1 second").pipe(
      Effect.andThen(
        lock.withPermit(
          Effect.gen(function* () {
            scheduled = false;
            if (!closed) yield* input.emit(reception);
          }),
        ),
      ),
      Effect.interruptible,
      Effect.forkIn(scope),
    );
  });

  const record = Effect.fnUntraced(function* (
    itemId: string,
    text: string,
    mode: "delta" | "snapshot",
  ) {
    if (text.length === 0) return;
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (closed) return;
        const item = items.get(itemId) ?? {
          streamBytes: 0,
          snapshotBytes: 0,
        };
        const previous = Math.max(item.streamBytes, item.snapshotBytes);
        const bytes = NodeBuffer.Buffer.byteLength(text, "utf8");
        if (mode === "delta") {
          item.streamBytes += bytes;
        } else {
          item.snapshotBytes = Math.max(item.snapshotBytes, bytes);
        }
        items.set(itemId, item);
        const added = Math.max(item.streamBytes, item.snapshotBytes) - previous;
        if (added === 0) return;
        const receivedAt = DateTime.formatIso(yield* DateTime.now);
        reception = {
          ...reception,
          receivedTextBytes: reception.receivedTextBytes + added,
          firstTextReceivedAt: reception.firstTextReceivedAt ?? receivedAt,
          lastTextReceivedAt: receivedAt,
        };
        yield* scheduleUpdate;
      }).pipe(Effect.uninterruptible),
    );
  });

  const observeOutputTokens = Effect.fnUntraced(function* (usageId: string, tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return;
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (closed) return;
        const previous = outputUsage.get(usageId);
        // A message may report cumulative usage in several streamed or snapshot frames.
        if (previous !== undefined && tokens <= previous) return;
        outputUsage.set(usageId, tokens);
        reception = {
          ...reception,
          outputTokens: (reception.outputTokens ?? 0) + tokens - (previous ?? 0),
        };
        yield* scheduleUpdate;
      }).pipe(Effect.uninterruptible),
    );
  });

  const stopProviderWait = (now: DateTime.Utc) => {
    const startMs = Date.parse(reception.providerWaitStartedAt ?? "");
    reception = {
      ...reception,
      providerWaitMs:
        (reception.providerWaitMs ?? 0) +
        (Number.isFinite(startMs) ? Math.max(0, DateTime.toEpochMillis(now) - startMs) : 0),
      providerWaitStartedAt: null,
    };
  };

  const startTool = Effect.fnUntraced(function* (toolId: string) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (closed || tools.has(toolId)) return;
        tools.set(toolId, true);
        if (activeTools++ > 0) return;
        stopProviderWait(yield* DateTime.now);
        yield* scheduleUpdate;
      }).pipe(Effect.uninterruptible),
    );
  });

  const endTool = Effect.fnUntraced(function* (toolId: string) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (closed || tools.get(toolId) !== true) return;
        tools.set(toolId, false);
        if (--activeTools > 0) return;
        reception = {
          ...reception,
          providerWaitStartedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* scheduleUpdate;
      }).pipe(Effect.uninterruptible),
    );
  });

  return {
    get current() {
      return reception;
    },
    append: (itemId, delta) => record(itemId, delta, "delta"),
    observeSnapshot: (itemId, text) => record(itemId, text, "snapshot"),
    observeOutputTokens,
    startTool,
    endTool,
    finish: (reportedOutputTokens) =>
      Effect.gen(function* () {
        const final = yield* lock.withPermit(
          Effect.gen(function* () {
            if (!closed) stopProviderWait(yield* DateTime.now);
            if (
              !closed &&
              reportedOutputTokens !== undefined &&
              Number.isSafeInteger(reportedOutputTokens) &&
              reportedOutputTokens >= 0
            ) {
              reception = { ...reception, outputTokens: reportedOutputTokens };
            }
            closed = true;
            items.clear();
            outputUsage.clear();
            tools.clear();
            return reception;
          }),
        );
        yield* Scope.close(scope, Exit.void);
        return final;
      }).pipe(Effect.uninterruptible),
  };
});
