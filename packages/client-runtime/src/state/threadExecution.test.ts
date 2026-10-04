import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ProviderSessionId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveResponseReception,
  formatResponseReception,
  presentPendingBackgroundWork,
  deriveReportedModelSelection,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  formatModelSelectionEffort,
  formatProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";
import { threadRuntimeCanArchive, type ThreadRuntimeSummary } from "./models.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("response reception presentation", () => {
  const active = { ...run("active", 2, "running"), rootNodeId: NodeId.make("root-active") };
  const receivedAt = "2026-07-28T10:00:00.000Z";
  const turn = (
    nodeId: string,
    bytes?: number,
    lastTextReceivedAt: string | null = receivedAt,
    outputTokens: number | null = bytes ?? null,
    firstTextReceivedAt: string | null = lastTextReceivedAt === null ? null : receivedAt,
  ) => ({
    id: ProviderTurnId.make(`turn-${nodeId}`),
    providerThreadId: ProviderThreadId.make("provider-thread"),
    nodeId: NodeId.make(nodeId),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running" as const,
    startedAt: now,
    completedAt: null,
    ...(bytes === undefined
      ? {}
      : {
          responseReception: {
            receivedTextBytes: bytes,
            outputTokens,
            firstTextReceivedAt,
            lastTextReceivedAt,
          },
        }),
  });

  it("sums roots of this run across attempts and excludes children and older runs", () => {
    const attempts = [
      {
        id: RunAttemptId.make("attempt"),
        runId: active.id,
        attemptOrdinal: 1,
        rootNodeId: NodeId.make("root-first"),
        providerInstanceId: active.providerInstanceId,
        providerThreadId: ProviderThreadId.make("provider-thread"),
        providerTurnId: null,
        reason: "initial" as const,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      },
    ];
    const projection = {
      ...v2Projection,
      runs: [run("old", 1, "completed"), active, run("queued", 3, "queued")],
      attempts,
      providerTurns: [
        turn("root-first", 1024, receivedAt, 120, "2026-07-28T09:59:58.000Z"),
        turn("root-active", 2048, "2026-07-28T10:00:01.000Z", 80),
        turn("child", 99999),
        turn("old", 99999),
      ],
    };
    expect(deriveResponseReception(projection)).toEqual({
      receivedTextBytes: 3072,
      outputTokens: 200,
      providerWaitMs: null,
      providerWaitStartedAt: null,
      firstTextReceivedAt: "2026-07-28T09:59:58.000Z",
      lastTextReceivedAt: "2026-07-28T10:00:01.000Z",
    });
    expect(
      deriveResponseReception({ ...projection, runs: [{ ...active, status: "completed" }] }),
    ).toMatchObject({ receivedTextBytes: 3072, outputTokens: 200 });
    expect(
      deriveResponseReception({
        ...projection,
        runs: [{ ...active, rootNodeId: NodeId.make("new-root") }],
        attempts: [],
        providerTurns: [...projection.providerTurns, turn("new-root", 0, null, null)],
      }),
    ).toEqual({
      receivedTextBytes: 0,
      outputTokens: null,
      providerWaitMs: null,
      providerWaitStartedAt: null,
      firstTextReceivedAt: null,
      lastTextReceivedAt: null,
    });
  });

  it("hides unsupported providers and old server data", () => {
    expect(
      deriveResponseReception({
        ...v2Projection,
        runs: [active],
        providerTurns: [turn("root-active")],
      }),
    ).toBeNull();
    expect(
      deriveResponseReception({
        ...v2Projection,
        providerTurns: [turn("root-active", 1024)],
      }),
    ).toBeNull();
  });

  it("keeps timing unavailable when an older root has no first reception time", () => {
    const old = turn("root-active", 12, receivedAt, 100);
    expect(
      deriveResponseReception({
        ...v2Projection,
        runs: [active],
        providerTurns: [
          {
            ...old,
            responseReception: {
              receivedTextBytes: 12,
              outputTokens: 100,
              lastTextReceivedAt: receivedAt,
            },
          },
        ],
      }),
    ).toEqual({
      receivedTextBytes: 12,
      outputTokens: 100,
      providerWaitMs: null,
      providerWaitStartedAt: null,
      firstTextReceivedAt: null,
      lastTextReceivedAt: receivedAt,
    });
  });

  const reception = {
    receivedTextBytes: 12,
    outputTokens: 1500,
    providerWaitMs: 64000,
    providerWaitStartedAt: null,
    lastTextReceivedAt: receivedAt,
  };

  it.each([
    [{ ...reception }, "[ ↓ 1.5k ( 23.4 tps) ]"],
    [{ ...reception, outputTokens: null }, "[ ↓ — ( — tps) ]"],
    [{ ...reception, outputTokens: 0 }, "[ ↓ 0 ( 0.0 tps) ]"],
    [{ ...reception, outputTokens: 999 }, "[ ↓ 999 ( 15.6 tps) ]"],
    [{ ...reception, outputTokens: 1000 }, "[ ↓ 1k ( 15.6 tps) ]"],
    [{ ...reception, outputTokens: 12500 }, "[ ↓ 12.5k ( 195.3 tps) ]"],
    [{ ...reception, outputTokens: 1500000 }, "[ ↓ 1.5m ( 23437.5 tps) ]"],
    [{ ...reception, receivedTextBytes: 1048576 }, "[ ↓ 1.5k ( 23.4 tps) ]"],
    [{ ...reception, providerWaitMs: null }, "[ ↓ 1.5k ( — tps) ]"],
    [{ ...reception, providerWaitMs: 0 }, "[ ↓ 1.5k ( — tps) ]"],
    [{ ...reception, providerWaitStartedAt: "invalid" }, "[ ↓ 1.5k ( — tps) ]"],
  ])("formats actual output tokens in the compact bracket display", (value, expected) => {
    expect(formatResponseReception(value, Date.parse(receivedAt))).toBe(expected);
  });

  it("recalculates TPS during provider waiting even without new text or usage reports", () => {
    const activeReception = {
      ...reception,
      providerWaitMs: 2000,
      providerWaitStartedAt: receivedAt,
    };
    expect(formatResponseReception(activeReception, Date.parse(receivedAt) + 3000)).toBe(
      "[ ↓ 1.5k ( 300.0 tps) ]",
    );
    expect(formatResponseReception(activeReception, Date.parse(receivedAt) + 8000)).toBe(
      "[ ↓ 1.5k ( 150.0 tps) ]",
    );
  });

  it("pauses TPS during tool execution and after completion", () => {
    expect(formatResponseReception(reception, Date.parse(receivedAt) + 3000)).toBe(
      "[ ↓ 1.5k ( 23.4 tps) ]",
    );
    expect(formatResponseReception(reception, Date.parse(receivedAt) + 60000)).toBe(
      "[ ↓ 1.5k ( 23.4 tps) ]",
    );
  });

  it("clamps active wait duration when the remote server clock is ahead", () => {
    expect(
      formatResponseReception(
        { ...reception, providerWaitMs: 5000, providerWaitStartedAt: receivedAt },
        Date.parse(receivedAt) - 1000,
      ),
    ).toBe("[ ↓ 1.5k ( 300.0 tps) ]");
  });

  it("uses provider waiting before the first text rather than the text reception interval", () => {
    expect(
      formatResponseReception(
        {
          ...reception,
          providerWaitMs: 10000,
          firstTextReceivedAt: receivedAt,
          lastTextReceivedAt: receivedAt,
        },
        Date.parse(receivedAt),
      ),
    ).toBe("[ ↓ 1.5k ( 150.0 tps) ]");
  });

  it("aggregates completed provider intervals and the current interval across root turns", () => {
    const previous = turn("root-active", 100, receivedAt, 120);
    const current = {
      ...turn("root-active", 200, receivedAt, 80),
      id: ProviderTurnId.make("second-provider-turn"),
    };
    const result = deriveResponseReception({
      ...v2Projection,
      runs: [active],
      providerTurns: [
        {
          ...previous,
          status: "completed",
          responseReception: {
            ...previous.responseReception!,
            providerWaitMs: 10000,
            providerWaitStartedAt: null,
          },
        },
        {
          ...current,
          responseReception: {
            ...current.responseReception!,
            providerWaitMs: 2000,
            providerWaitStartedAt: receivedAt,
          },
        },
        turn("child", 99999),
      ],
    });
    expect(result).toMatchObject({
      outputTokens: 200,
      providerWaitMs: 12000,
      providerWaitStartedAt: receivedAt,
    });
    expect(formatResponseReception(result!, Date.parse(receivedAt) + 3000)).toBe(
      "[ ↓ 200 ( 13.3 tps) ]",
    );
  });

  it("keeps TPS unavailable when a root has legacy metadata without tool timing", () => {
    const result = deriveResponseReception({
      ...v2Projection,
      runs: [active],
      providerTurns: [turn("root-active", 12, receivedAt, 100)],
    });
    expect(result?.providerWaitMs).toBeNull();
    expect(formatResponseReception(result!, Date.parse(receivedAt) + 3000)).toBe(
      "[ ↓ 100 ( — tps) ]",
    );
  });
});

describe("thread execution presentation", () => {
  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

  it("counts a wake run's activity from the start of the work it continues", () => {
    const workStartedAt = DateTime.makeUnsafe("2026-07-28T09:20:00.000Z");
    const wake = { ...run("wake", 2, "running"), workStartedAt };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "completed"), wake] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T09:20:00.000Z");
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "running")] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T10:00:00.000Z");
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
      }),
    ).toMatchObject({ status: "queued", lastErrorClass: null });
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });

    // Resuming clears the hold, and the run reads as queued until it starts.
    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    // Recovery can hold a first message before any run executed; it is not work.
    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("keeps checkpoint-wait activity visible without exposing a non-functional interrupt", () => {
    const waitingRun = run("run-waiting", 1, "waiting");
    const projection = { ...v2Projection, runs: [waitingRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: waitingRun.id,
      status: "waiting",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "waiting",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("does not expose a stale active run after the runtime parks at idle", () => {
    const runtime = {
      status: "idle" as const,
      activeRunId: RunId.make("run-stale"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it.each(["preparing", "starting"] as const)("keeps an active %s run interruptible", (status) => {
    const runtime = {
      status,
      activeRunId: RunId.make(`run-${status}`),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    // The subagent has no run, so it stays unstoppable and unqueueable.
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it.each(["completed", "cancelled", "failed", "interrupted", "idle"] as const)(
    "is idle once the subagent is %s",
    (status) => {
      expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [rootTurn(status)] })).toBe(null);
    },
  );

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("reports the provider's own subagent from its runless root turn", () => {
    expect(deriveProviderSubagentStatus(child("provider"))).toEqual({
      status: "completed",
      startedAt: "2026-07-28T10:00:00.000Z",
      completedAt: "2026-07-28T10:00:00.000Z",
    });
  });

  it("says how long the subagent has worked, or took", () => {
    const startedAt = "2026-07-28T10:00:00.000Z";
    const at = (iso: string) => Date.parse(iso);
    expect(
      formatProviderSubagentStatus(
        { status: "running", startedAt, completedAt: null },
        at("2026-07-28T10:01:05.400Z"),
      ),
    ).toBe("Working 1m 5s");
    expect(
      formatProviderSubagentStatus(
        { status: "completed", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        at("2026-07-28T11:00:00.000Z"),
      ),
    ).toBe("Completed in 34s");
    expect(
      formatProviderSubagentStatus(
        { status: "cancelled", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        0,
      ),
    ).toBe("Cancelled");
    expect(formatProviderSubagentStatus(null, 0)).toBe("Starting");
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("formatModelSelectionEffort", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const selection = (options?: ReadonlyArray<{ id: string; value: string }>) => ({
    instanceId,
    model: "claude-sonnet-5",
    ...(options === undefined ? {} : { options }),
  });
  const catalog = (descriptor: { currentValue?: string }) => [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
            ...descriptor,
          },
        ],
      },
    },
  ];

  it("shows the model's default effort when the user never picked one", () => {
    expect(formatModelSelectionEffort(selection(), catalog({}))).toBe("High");
  });

  it("names a stored effort the way the catalog does", () => {
    expect(
      formatModelSelectionEffort(selection([{ id: "effort", value: "xhigh" }]), catalog({})),
    ).toBe("Extra High");
  });

  it("uses the descriptor's current value over the default", () => {
    expect(formatModelSelectionEffort(selection(), catalog({ currentValue: "medium" }))).toBe(
      "Medium",
    );
  });

  it("shows nothing for a model the catalog does not describe", () => {
    expect(formatModelSelectionEffort(selection([{ id: "effort", value: "high" }]))).toBeNull();
    expect(
      formatModelSelectionEffort(
        { ...selection(), model: "claude-haiku-4-5" },
        catalog({ currentValue: "medium" }),
      ),
    ).toBeNull();
  });
});

describe("threadRuntimeCanArchive", () => {
  const runtime = (
    status: ThreadRuntimeSummary["status"],
    activeRunId: ThreadRuntimeSummary["activeRunId"],
  ): ThreadRuntimeSummary => ({
    status,
    activeRunId,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: DateTime.formatIso(now),
  });

  it.each(["preparing", "starting", "running"] as const)(
    "blocks archive while a provider is %s",
    (status) => {
      expect(threadRuntimeCanArchive(runtime(status, RunId.make(`run-${status}`)))).toBe(false);
    },
  );

  it("only blocks a queued runtime when a provider run remains attached", () => {
    expect(threadRuntimeCanArchive(runtime("queued", RunId.make("run-queued")))).toBe(false);
    expect(threadRuntimeCanArchive(runtime("queued", null))).toBe(true);
  });

  it("allows waiting and idle threads", () => {
    expect(threadRuntimeCanArchive(runtime("waiting", RunId.make("run-finished")))).toBe(true);
    expect(threadRuntimeCanArchive(runtime("idle", null))).toBe(true);
  });
});

describe("presentPendingBackgroundWork", () => {
  it.each(["Subagent:", "Subagent:   "])(
    "falls back to the subagent noun when %s has no display name",
    (description) => {
      const presentation = presentPendingBackgroundWork([
        { taskId: "unnamed", kind: "subagent", description },
      ]);

      expect(presentation?.title).toBe("Waiting on a subagent");
      expect(presentation?.items[0]?.label).toBe("subagent");
    },
  );

  it.each([
    "/root/luna_window_properties",
    "Subagent: /root/luna_window_properties",
    "/root/parent/luna_window_properties",
  ])("uses the subagent display name for %s", (description) => {
    const childThreadId = ThreadId.make("thread:luna");
    const presentation = presentPendingBackgroundWork([
      { taskId: "luna", kind: "subagent", description, childThreadId },
    ]);

    expect(presentation).toEqual({
      title: "Waiting on subagent Luna Window Properties",
      items: [{ taskId: "luna", kind: "subagent", label: "Luna Window Properties", childThreadId }],
      waiting: true,
    });
  });

  it("formats subagent names in a mixed roster and preserves command descriptions", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "/root/run_tests" },
      { taskId: "luna", kind: "subagent", description: "/root/luna_window_properties" },
      { taskId: "review", kind: "subagent", description: "Review src/math.ts" },
    ]);

    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => item.label)).toEqual([
      "Luna Window Properties",
      "Review src/math.ts",
      "/root/run_tests",
    ]);
  });

  it("names a single piece of work by kind", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
      ])?.title,
    ).toBe("Waiting on subagent Review src/math.ts");
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "monitor" }])?.title).toBe(
      "Waiting on a monitor",
    );
    expect(presentPendingBackgroundWork([])).toBeNull();
  });

  // A command left running, such as a dev server, does not wake the agent.
  it("says only commands are running, not waited on", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "dev", kind: "command", description: "Start the shared dev server" },
      ]),
    ).toMatchObject({ title: "Running: Start the shared dev server", waiting: false });
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command" }])).toMatchObject({
      title: "Running a command",
      waiting: false,
    });
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "command", description: "vp run dev" },
        { taskId: "b", kind: "command", description: "tailscale serve" },
      ]),
    ).toMatchObject({ title: "Running 2 commands", waiting: false });
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "command", description: "vp run dev" },
        { taskId: "b", kind: "monitor", description: "Watch PR checks" },
      ]),
    ).toMatchObject({ title: "Waiting on 1 command and 1 monitor", waiting: true });
  });

  it("groups work by kind, subagents first, and keeps each name", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "npm test" },
      {
        taskId: "b",
        kind: "subagent",
        description: "Write tests",
        childThreadId: ThreadId.make("thread:b"),
      },
      { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
    ]);
    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => [item.kind, item.label, item.childThreadId])).toEqual([
      ["subagent", "Write tests", "thread:b"],
      ["subagent", "Review src/math.ts", undefined],
      ["command", "npm test", undefined],
    ]);
  });

  it("names generic work, including rosters from servers that predate kinds", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "bash", kind: "command", description: "Background sleep" },
        { taskId: "watch", kind: "monitor" },
        { taskId: "other", kind: "background_task" },
      ])?.title,
    ).toBe("Waiting on 1 command, 1 monitor and 1 background task");
    expect(presentPendingBackgroundWork([{ taskId: "old", kind: "background_task" }])?.title).toBe(
      "Waiting on a background task",
    );
  });
});

describe("provider-reported model selection", () => {
  const selected = v2Projection.thread.modelSelection;
  const reported = { ...selected, options: [{ id: "reasoningEffort", value: "default" }] };
  const providerThread = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selected.instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    nativeMetadata: { modelSelection: reported },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
    providerThreads: [providerThread],
  };

  it("reads only the active provider thread's reported selection", () => {
    expect(deriveReportedModelSelection(projection)).toBe(reported);
    expect(
      deriveReportedModelSelection({
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: null },
      }),
    ).toBeNull();
    expect(
      deriveReportedModelSelection({
        ...projection,
        providerThreads: [
          { ...providerThread, providerInstanceId: ProviderInstanceId.make("other") },
        ],
      }),
    ).toBeNull();
  });

  it("shows the reported default in a subagent's effort label", () => {
    const models = [
      {
        slug: selected.model,
        name: selected.model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "variant",
              label: "Reasoning",
              type: "select" as const,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      },
    ];
    const variantReport = { ...selected, options: [{ id: "variant", value: "default" }] };
    expect(formatModelSelectionEffort(selected, models, variantReport)).toBe("Default");
    expect(formatModelSelectionEffort(selected, models)).toBe("Unknown");
  });
});
