import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2ResponseReception } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { makeProviderResponseReception } from "./ProviderResponseReception.ts";

describe("provider response reception", () => {
  it.effect("counts UTF-8 text once across deltas and repeated snapshots per block", () =>
    Effect.gen(function* () {
      const reception = yield* makeProviderResponseReception({ emit: () => Effect.void });
      assert.include(reception.current, {
        receivedTextBytes: 0,
        outputTokens: null,
        firstTextReceivedAt: null,
        lastTextReceivedAt: null,
      });
      yield* reception.append("first", "안녕");
      yield* reception.append("first", "🙂");
      yield* reception.observeSnapshot("first", "안녕🙂!");
      const receivedAt = reception.current.lastTextReceivedAt;
      yield* TestClock.adjust("100 millis");
      yield* reception.observeSnapshot("first", "안녕🙂!");
      yield* reception.observeSnapshot("first", "short");
      yield* reception.append("first", "!");
      assert.include(reception.current, {
        receivedTextBytes: 11,
        outputTokens: null,
        firstTextReceivedAt: receivedAt,
        lastTextReceivedAt: receivedAt,
      });
      yield* reception.append("second", "abc");
      yield* reception.observeSnapshot("second", "abc");
      yield* reception.observeSnapshot("snapshot-only", "가");
      assert.equal(reception.current.receivedTextBytes, 17);
      assert.equal(reception.current.firstTextReceivedAt, receivedAt);
      assert.equal(reception.current.lastTextReceivedAt, DateTime.formatIso(yield* DateTime.now));
      yield* reception.finish();
    }),
  );

  it.effect("batches metadata at most once per second without idle updates", () =>
    Effect.gen(function* () {
      const updates: Array<OrchestrationV2ResponseReception> = [];
      const reception = yield* makeProviderResponseReception({
        emit: (value) =>
          Effect.sync(() => {
            updates.push(value);
          }),
      });
      yield* reception.append("body", "one");
      yield* reception.append("body", " two");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("999 millis");
      assert.isEmpty(updates);
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(updates, [reception.current]);
      yield* reception.append("body", " three");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      assert.equal(updates.length, 2);
      assert.equal(updates[1]?.receivedTextBytes, 13);
      yield* TestClock.adjust("10 seconds");
      assert.equal(updates.length, 2);
      yield* reception.finish();
    }),
  );

  it.effect("returns the final snapshot and cancels pending updates on finish", () =>
    Effect.gen(function* () {
      const updates: Array<OrchestrationV2ResponseReception> = [];
      const reception = yield* makeProviderResponseReception({
        emit: (value) =>
          Effect.sync(() => {
            updates.push(value);
          }),
      });
      yield* reception.append("body", "partial");
      yield* reception.observeSnapshot("body", "partial final");
      const final = yield* reception.finish();
      assert.equal(final.receivedTextBytes, 13);
      yield* reception.append("body", "late");
      yield* reception.observeSnapshot("other", "late snapshot");
      yield* TestClock.adjust("2 seconds");
      assert.isEmpty(updates);
      assert.deepEqual(yield* reception.finish(), final);
      const next = yield* makeProviderResponseReception({ emit: () => Effect.void });
      assert.include(next.current, {
        receivedTextBytes: 0,
        outputTokens: null,
        firstTextReceivedAt: null,
        lastTextReceivedAt: null,
      });
      yield* next.finish();
    }),
  );

  it.effect("stops updates when the owning session scope closes", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.make();
      const updates: Array<OrchestrationV2ResponseReception> = [];
      const reception = yield* makeProviderResponseReception({
        emit: (value) =>
          Effect.sync(() => {
            updates.push(value);
          }),
      }).pipe(Effect.provideService(Scope.Scope, sessionScope));
      yield* reception.append("body", "before close");
      yield* Scope.close(sessionScope, Exit.void);
      yield* reception.append("body", "after close");
      yield* TestClock.adjust("2 seconds");
      assert.isEmpty(updates);
      assert.equal(reception.current.receivedTextBytes, 12);
    }),
  );

  it.effect("measures only the first through last unique text and freezes while idle", () =>
    Effect.gen(function* () {
      const reception = yield* makeProviderResponseReception({ emit: () => Effect.void });
      yield* TestClock.adjust("30 seconds");
      yield* reception.append("body", "first");
      const firstTextReceivedAt = DateTime.formatIso(yield* DateTime.now);
      yield* TestClock.adjust("2 seconds");
      yield* reception.append("body", " last");
      const lastTextReceivedAt = DateTime.formatIso(yield* DateTime.now);
      yield* TestClock.adjust("20 seconds");
      yield* reception.observeSnapshot("body", "first last");
      assert.include(yield* reception.finish(), {
        receivedTextBytes: 10,
        outputTokens: null,
        firstTextReceivedAt,
        lastTextReceivedAt,
      });
    }),
  );

  it.effect("sums provider output reports per message without estimating or counting repeats", () =>
    Effect.gen(function* () {
      const updates: Array<OrchestrationV2ResponseReception> = [];
      const reception = yield* makeProviderResponseReception({
        emit: (value) =>
          Effect.sync(() => {
            updates.push(value);
          }),
      });
      yield* reception.append("body", "This text is not a token count");
      assert.isNull(reception.current.outputTokens);
      const firstTextReceivedAt = reception.current.firstTextReceivedAt;
      const lastTextReceivedAt = reception.current.lastTextReceivedAt;
      yield* reception.observeOutputTokens("message-1", 0);
      assert.equal(reception.current.outputTokens, 0);
      yield* reception.observeOutputTokens("message-1", 10);
      yield* reception.observeOutputTokens("message-1", 10);
      yield* reception.observeOutputTokens("message-1", 5);
      yield* reception.observeOutputTokens("message-1", 25);
      yield* reception.observeOutputTokens("message-2", 7);
      for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        yield* reception.observeOutputTokens("invalid", invalid);
      }
      assert.equal(reception.current.outputTokens, 32);
      assert.equal(reception.current.firstTextReceivedAt, firstTextReceivedAt);
      assert.equal(reception.current.lastTextReceivedAt, lastTextReceivedAt);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(updates, [reception.current]);
      const final = yield* reception.finish();
      yield* reception.observeOutputTokens("message-2", 100);
      assert.equal(final.outputTokens, 32);
      assert.deepEqual(reception.current, final);
    }),
  );

  it.effect("can report actual output usage before any visible text", () =>
    Effect.gen(function* () {
      const reception = yield* makeProviderResponseReception({ emit: () => Effect.void });
      yield* reception.observeOutputTokens("message", 20);
      assert.include(yield* reception.finish(), {
        receivedTextBytes: 0,
        outputTokens: 20,
        firstTextReceivedAt: null,
        lastTextReceivedAt: null,
      });
    }),
  );

  it.effect(
    "includes initial and subsequent provider waits while excluding the union of parallel tools",
    () =>
      Effect.gen(function* () {
        const startedAt = yield* DateTime.now;
        const reception = yield* makeProviderResponseReception({
          startedAt,
          emit: () => Effect.void,
        });
        assert.equal(reception.current.providerWaitMs, 0);
        assert.equal(reception.current.providerWaitStartedAt, DateTime.formatIso(startedAt));
        yield* TestClock.adjust("5 seconds");
        yield* reception.observeOutputTokens("message", 1500);
        yield* reception.startTool("first");
        assert.equal(reception.current.providerWaitMs, 5000);
        assert.isNull(reception.current.providerWaitStartedAt);
        yield* TestClock.adjust("2 seconds");
        yield* reception.startTool("second");
        yield* reception.startTool("second");
        yield* TestClock.adjust("3 seconds");
        yield* reception.endTool("first");
        assert.isNull(reception.current.providerWaitStartedAt);
        yield* TestClock.adjust("3 seconds");
        yield* reception.endTool("second");
        assert.equal(
          reception.current.providerWaitStartedAt,
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* reception.endTool("second");
        yield* reception.endTool("unseen");
        yield* reception.startTool("first");
        yield* TestClock.adjust("5 seconds");
        const final = yield* reception.finish();
        assert.equal(final.providerWaitMs, 10000);
        assert.isNull(final.providerWaitStartedAt);
        assert.equal(final.outputTokens, 1500);
        yield* TestClock.adjust("5 seconds");
        yield* reception.endTool("first");
        assert.deepEqual(yield* reception.finish(), final);
      }),
  );

  it.effect("excludes an unfinished tool when the turn is interrupted or fails", () =>
    Effect.gen(function* () {
      const reception = yield* makeProviderResponseReception({ emit: () => Effect.void });
      yield* TestClock.adjust("4 seconds");
      yield* reception.startTool("unfinished");
      yield* TestClock.adjust("20 seconds");
      const final = yield* reception.finish();
      assert.equal(final.providerWaitMs, 4000);
      assert.isNull(final.providerWaitStartedAt);
    }),
  );

  it.effect("emits tool timing transitions without continuously sending idle time updates", () =>
    Effect.gen(function* () {
      const updates: Array<OrchestrationV2ResponseReception> = [];
      const reception = yield* makeProviderResponseReception({
        emit: (value) =>
          Effect.sync(() => {
            updates.push(value);
          }),
      });
      yield* TestClock.adjust("4 seconds");
      assert.isEmpty(updates);
      yield* reception.startTool("tool");
      yield* TestClock.adjust("1 second");
      assert.equal(updates[0]?.providerWaitMs, 4000);
      assert.isNull(updates[0]?.providerWaitStartedAt);
      yield* TestClock.adjust("20 seconds");
      assert.lengthOf(updates, 1);
      yield* reception.endTool("tool");
      const resumedAt = DateTime.formatIso(yield* DateTime.now);
      yield* TestClock.adjust("1 second");
      assert.equal(updates[1]?.providerWaitStartedAt, resumedAt);
      yield* TestClock.adjust("20 seconds");
      assert.lengthOf(updates, 2);
      yield* reception.finish();
    }),
  );

  it.effect("reconciles partial reports with the final provider total once", () =>
    Effect.gen(function* () {
      const reception = yield* makeProviderResponseReception({ emit: () => Effect.void });
      yield* reception.append("body", "Output");
      yield* reception.observeOutputTokens("message", 0);
      const receivedAt = reception.current.lastTextReceivedAt;
      const final = yield* reception.finish(100);
      assert.equal(final.outputTokens, 100);
      assert.equal(final.lastTextReceivedAt, receivedAt);
      assert.deepEqual(yield* reception.finish(200), final);
    }),
  );
});
