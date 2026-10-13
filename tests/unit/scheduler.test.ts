import { describe, expect, it } from "vitest";
import {
  runWorkflow,
  type ExecutionSummary,
  type TaskExecutor,
  type Workflow,
} from "../../packages/core/src/index.js";

/** Builds a workflow from [id, dependencies] pairs, preserving declared order. */
function wf(spec: Array<[string, string[]]>): Workflow {
  return {
    id: "wf-test",
    name: "test workflow",
    tasks: spec.map(([id, dependencies]) => ({ id, name: id, dependencies })),
  };
}

/** Builds a deliberately malformed workflow (bypasses the type system on purpose). */
function raw(tasks: unknown): Workflow {
  return { id: "wf-raw", name: "raw", tasks } as unknown as Workflow;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the scheduler consume every already-settled promise. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Executor whose tasks stay running until the test releases them. */
function gated(ids: string[]) {
  const started: string[] = [];
  const gates = new Map(ids.map((id) => [id, deferred<string>()]));
  let active = 0;
  let maxActive = 0;

  const execute: TaskExecutor<string> = async (task) => {
    started.push(task.id);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      return await gates.get(task.id)!.promise;
    } finally {
      active--;
    }
  };

  return {
    started,
    execute,
    release: (id: string) => gates.get(id)!.resolve(id),
    fail: (id: string, reason: unknown) => gates.get(id)!.reject(reason),
    maxActive: () => maxActive,
  };
}

const outcomes = (summary: ExecutionSummary<unknown>) =>
  Object.fromEntries(summary.results.map((r) => [r.taskId, r.outcome]));

const resultOf = (summary: ExecutionSummary<unknown>, id: string) =>
  summary.results.find((r) => r.taskId === id)!;

/** Runs a one-task workflow whose executor rejects with `reason`, returns the Error. */
async function errorFrom(reason: unknown): Promise<Error> {
  const summary = await runWorkflow(wf([["t", []]]), () => Promise.reject(reason));
  const result = resultOf(summary, "t");
  if (result.outcome !== "failed") throw new Error("expected the task to fail");
  return result.error;
}

describe("dependency ordering", () => {
  it("starts a task only after all of its dependencies have finished", async () => {
    const w = wf([
      ["a", []],
      ["b", ["a"]],
      ["c", ["a"]],
      ["d", ["b", "c"]],
    ]);
    const events: string[] = [];
    const execute: TaskExecutor<string> = async (task) => {
      events.push(`start:${task.id}`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`end:${task.id}`);
      return task.id;
    };

    const summary = await runWorkflow(w, execute, { concurrency: 4 });

    expect(summary.ok).toBe(true);
    for (const task of w.tasks) {
      for (const dep of task.dependencies) {
        expect(events.indexOf(`end:${dep}`)).toBeLessThan(events.indexOf(`start:${task.id}`));
      }
    }
    expect(summary.startOrder).toEqual(["a", "b", "c", "d"]);
  });

  it("returns each task's value and logical timings", async () => {
    const summary = await runWorkflow(wf([["a", []], ["b", ["a"]]]), (t) => `${t.id}-done`);
    const a = resultOf(summary, "a");
    const b = resultOf(summary, "b");
    expect(a).toMatchObject({ outcome: "succeeded", value: "a-done" });
    expect(b).toMatchObject({ outcome: "succeeded", value: "b-done" });
    if (a.outcome === "succeeded" && b.outcome === "succeeded") {
      expect(a.finishedAt).toBeLessThan(b.startedAt);
    }
  });

  it("supports synchronous executors", async () => {
    const summary = await runWorkflow(wf([["a", []], ["b", ["a"]]]), (t) => t.id);
    expect(summary.ok).toBe(true);
  });

  it("passes the caller's original task object to the executor", async () => {
    const w = wf([["a", []]]);
    let received: unknown;
    await runWorkflow(w, (task) => {
      received = task;
    });
    expect(received).toBe(w.tasks[0]);
  });
});

describe("concurrency", () => {
  it("runs independent tasks concurrently", async () => {
    const h = gated(["x", "y", "z"]);
    const done = runWorkflow(wf([["x", []], ["y", []], ["z", []]]), h.execute, { concurrency: 3 });

    await flush();
    expect(h.started).toEqual(["x", "y", "z"]); // all running before any finished

    ["x", "y", "z"].forEach(h.release);
    const summary = await done;
    expect(summary.ok).toBe(true);
    expect(summary.maxObservedConcurrency).toBe(3);
  });

  it("never exceeds the concurrency limit and refills freed slots in declared order", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const h = gated(ids);
    const done = runWorkflow(wf(ids.map((id) => [id, []] as [string, string[]])), h.execute, {
      concurrency: 2,
    });

    await flush();
    expect(h.started).toEqual(["a", "b"]);

    h.release("a");
    await flush();
    expect(h.started).toEqual(["a", "b", "c"]);

    h.release("b");
    await flush();
    expect(h.started).toEqual(["a", "b", "c", "d"]);

    ["c", "d", "e"].forEach(h.release);
    const summary = await done;

    expect(summary.ok).toBe(true);
    expect(h.maxActive()).toBe(2);
    expect(summary.maxObservedConcurrency).toBe(2);
  });

  it("with concurrency 1 runs strictly one task at a time in declared order", async () => {
    const h = gated(["c", "a", "b"]);
    const done = runWorkflow(wf([["c", []], ["a", []], ["b", []]]), h.execute, { concurrency: 1 });

    await flush();
    expect(h.started).toEqual(["c"]);
    h.release("c");
    await flush();
    expect(h.started).toEqual(["c", "a"]);
    h.release("a");
    await flush();
    h.release("b");

    const summary = await done;
    expect(summary.startOrder).toEqual(["c", "a", "b"]);
    expect(h.maxActive()).toBe(1);
    expect(summary.maxObservedConcurrency).toBe(1);
  });

  it("does not start a dependent while its dependency is still running, even with free slots", async () => {
    const h = gated(["a", "b"]);
    const done = runWorkflow(wf([["a", []], ["b", ["a"]]]), h.execute, { concurrency: 4 });

    await flush();
    expect(h.started).toEqual(["a"]);
    h.release("a");
    await flush();
    expect(h.started).toEqual(["a", "b"]);
    h.release("b");
    await done;
  });
});

describe("startOrder and completion timing", () => {
  const graph = () =>
    wf([
      ["a", []],
      ["b", []],
      ["c", ["a"]],
      ["d", ["b"]],
    ]);

  it("depends on completion order when slots are limited (documented behavior)", async () => {
    // Same graph, same concurrency; only the completion order differs.
    const first = gated(["a", "b", "c", "d"]);
    const run1 = runWorkflow(graph(), first.execute, { concurrency: 2 });
    await flush();
    first.release("a");
    await flush();
    first.release("b");
    await flush();
    ["c", "d"].forEach(first.release);
    const s1 = await run1;

    const second = gated(["a", "b", "c", "d"]);
    const run2 = runWorkflow(graph(), second.execute, { concurrency: 2 });
    await flush();
    second.release("b");
    await flush();
    second.release("a");
    await flush();
    ["c", "d"].forEach(second.release);
    const s2 = await run2;

    expect(s1.startOrder).toEqual(["a", "b", "c", "d"]);
    expect(s2.startOrder).toEqual(["a", "b", "d", "c"]);
  });

  it("breaks ties in declared order when tasks complete together", async () => {
    const h = gated(["a", "b", "c", "d"]);
    const done = runWorkflow(graph(), h.execute, { concurrency: 2 });
    await flush();
    h.release("b"); // both complete before the scheduler runs again
    h.release("a");
    await flush();
    expect(h.started).toEqual(["a", "b", "c", "d"]);
    ["c", "d"].forEach(h.release);
    await done;
  });

  it("produces the same start order for the same graph and completion order", async () => {
    const w = wf([
      ["a", []],
      ["b", []],
      ["c", ["a"]],
      ["d", ["b"]],
      ["e", ["c", "d"]],
    ]);
    const runs = await Promise.all(
      [1, 2, 3].map(() => runWorkflow(w, (t) => t.id, { concurrency: 2 })),
    );
    expect(runs[1]!.startOrder).toEqual(runs[0]!.startOrder);
    expect(runs[2]!.startOrder).toEqual(runs[0]!.startOrder);
  });
});

describe("completion queue", () => {
  it("does not attach repeated handlers to long-running tasks", async () => {
    const longIds = Array.from({ length: 20 }, (_, i) => `long${i}`);
    const shortIds = Array.from({ length: 300 }, (_, i) => `short${i}`);
    const h = gated(longIds);
    const spec = [...longIds, ...shortIds].map((id) => [id, []] as [string, string[]]);
    const execute: TaskExecutor<string> = (task) =>
      task.id.startsWith("long") ? h.execute(task) : task.id;

    const original = Promise.prototype.then;
    let thenCalls = 0;
    Promise.prototype.then = function (this: Promise<unknown>, ...args: unknown[]) {
      thenCalls++;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof Promise.prototype.then;

    let summary: ExecutionSummary<string>;
    try {
      // 20 long tasks hold 20 slots while one slot cycles through 300 short tasks.
      const done = runWorkflow(wf(spec), execute, { concurrency: 21 });
      await flush();
      longIds.forEach(h.release);
      summary = await done;
    } finally {
      Promise.prototype.then = original;
    }

    expect(summary.ok).toBe(true);
    // A race over all running promises on every completion would attach ~21 handlers
    // per short task (thousands in total). One handler pair per task stays near 2n.
    expect(thenCalls).toBeLessThan(4 * spec.length);
  });
});

describe("failures", () => {
  it("blocks downstream tasks and never starts them", async () => {
    const calls: string[] = [];
    const execute: TaskExecutor<string> = async (task) => {
      calls.push(task.id);
      if (task.id === "a") throw new Error("a broke");
      return task.id;
    };

    const summary = await runWorkflow(
      wf([["a", []], ["b", ["a"]], ["c", ["b"]]]),
      execute,
    );

    expect(calls).toEqual(["a"]);
    expect(outcomes(summary)).toEqual({ a: "failed", b: "blocked", c: "blocked" });
    expect(summary.ok).toBe(false);
    expect(summary.counts).toEqual({ succeeded: 0, failed: 1, blocked: 2 });
    const a = resultOf(summary, "a");
    expect(a.outcome === "failed" && a.error.message).toBe("a broke");
  });

  it("propagates a failure transitively and reports the root cause on every blocked task", async () => {
    const execute: TaskExecutor<string> = async (task) => {
      if (task.id === "a") throw new Error("a broke");
      return task.id;
    };
    const summary = await runWorkflow(
      wf([["a", []], ["b", ["a"]], ["c", ["b"]], ["d", ["c"]], ["e", ["b", "d"]], ["ok", []]]),
      execute,
    );
    expect(outcomes(summary)).toEqual({
      a: "failed",
      b: "blocked",
      c: "blocked",
      d: "blocked",
      e: "blocked",
      ok: "succeeded",
    });
    for (const id of ["b", "c", "d", "e"]) {
      expect(resultOf(summary, id)).toMatchObject({ blockedBy: ["a"] }); // root, not parent
    }
  });

  it("lets unrelated branches finish, including work already in flight", async () => {
    const h = gated(["a", "b", "x", "y"]);
    const done = runWorkflow(
      wf([["a", []], ["b", ["a"]], ["x", []], ["y", ["x"]]]),
      h.execute,
      { concurrency: 2 },
    );

    await flush();
    expect(h.started).toEqual(["a", "x"]);

    h.fail("a", new Error("boom")); // x is still running when a fails
    await flush();
    expect(h.started).toEqual(["a", "x"]); // b is blocked, so nothing new starts

    h.release("x");
    await flush();
    expect(h.started).toEqual(["a", "x", "y"]);
    h.release("y");

    const summary = await done;
    expect(outcomes(summary)).toEqual({ a: "failed", b: "blocked", x: "succeeded", y: "succeeded" });
    expect(h.started).not.toContain("b");
  });

  it("blocks a join task when only one of its branches fails", async () => {
    const execute: TaskExecutor<string> = async (task) => {
      if (task.id === "b") throw new Error("b broke");
      return task.id;
    };
    const summary = await runWorkflow(
      wf([["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]]),
      execute,
    );
    expect(outcomes(summary)).toEqual({ a: "succeeded", b: "failed", c: "succeeded", d: "blocked" });
    expect(resultOf(summary, "d")).toMatchObject({ blockedBy: ["b"] });
  });

  it("reports multiple failed prerequisites, sorted regardless of declared or failure order", async () => {
    const h = gated(["z", "m", "a", "join", "after"]);
    const done = runWorkflow(
      wf([["z", []], ["m", []], ["a", []], ["join", ["z", "m", "a"]], ["after", ["join"]]]),
      h.execute,
      { concurrency: 3 },
    );
    await flush();
    h.fail("m", new Error("m"));
    await flush();
    h.fail("z", new Error("z"));
    await flush();
    h.release("a"); // a succeeds; only z and m are root causes
    const summary = await done;

    expect(resultOf(summary, "join")).toMatchObject({ outcome: "blocked", blockedBy: ["m", "z"] });
    expect(resultOf(summary, "after")).toMatchObject({ outcome: "blocked", blockedBy: ["m", "z"] });
    expect(summary.counts).toEqual({ succeeded: 1, failed: 2, blocked: 2 });
  });

  it("sorts blockedBy when roots reach a task through different blocked paths", async () => {
    const execute: TaskExecutor<string> = async (task) => {
      if (task.id === "y" || task.id === "b") throw new Error(task.id);
      return task.id;
    };
    const summary = await runWorkflow(
      wf([["y", []], ["b", []], ["p", ["y"]], ["q", ["b"]], ["end", ["p", "q"]]]),
      execute,
    );
    expect(resultOf(summary, "p")).toMatchObject({ blockedBy: ["y"] });
    expect(resultOf(summary, "q")).toMatchObject({ blockedBy: ["b"] });
    expect(resultOf(summary, "end")).toMatchObject({ blockedBy: ["b", "y"] });
  });
});

describe("rejections and throws", () => {
  it("does not hang when an executor throws synchronously, rejects, or rejects with a non-Error", async () => {
    const execute: TaskExecutor<string> = (task) => {
      if (task.id === "sync") throw new Error("sync throw");
      if (task.id === "reject") return Promise.reject(new Error("async reject"));
      if (task.id === "string") return Promise.reject("plain string");
      return Promise.resolve(task.id);
    };

    const summary = await runWorkflow(
      wf([["sync", []], ["reject", []], ["string", []], ["ok", []], ["after", ["sync"]]]),
      execute,
      { concurrency: 2 },
    );

    expect(outcomes(summary)).toEqual({
      sync: "failed",
      reject: "failed",
      string: "failed",
      ok: "succeeded",
      after: "blocked",
    });
    const sync = resultOf(summary, "sync");
    const rejected = resultOf(summary, "reject");
    const str = resultOf(summary, "string");
    expect(sync.outcome === "failed" && sync.error.message).toBe("sync throw");
    expect(rejected.outcome === "failed" && rejected.error.message).toBe("async reject");
    expect(str.outcome === "failed" && str.error.message).toBe("plain string");
  });

  it("returns Error instances unchanged", async () => {
    const original = new RangeError("range");
    const error = await errorFrom(original);
    expect(error).toBe(original);
  });

  it("keeps message, name and original value for plain objects with a message", async () => {
    const reason = { name: "TimeoutError", message: "upstream timed out", code: "E_TIMEOUT" };
    const error = await errorFrom(reason);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("upstream timed out");
    expect(error.name).toBe("TimeoutError");
    expect(error.cause).toBe(reason);
  });

  it("embeds a JSON description when a plain object has no usable message", async () => {
    const reason = { code: "E_QUOTA", detail: "limit reached" };
    const error = await errorFrom(reason);
    expect(error.message).toContain('{"code":"E_QUOTA","detail":"limit reached"}');
    expect(error.message).not.toContain("[object Object]");
    expect(error.cause).toBe(reason);
  });

  it("ignores a non-string or empty message and falls back to JSON", async () => {
    expect((await errorFrom({ message: 42, code: 1 })).message).toContain('"code":1');
    expect((await errorFrom({ message: "", code: 2 })).message).toContain('"code":2');
  });

  it("survives unserializable and hostile rejection values", async () => {
    const circular: Record<string, unknown> = { code: "E_LOOP" };
    circular.self = circular;
    const circularError = await errorFrom(circular);
    expect(circularError.message).toContain("unserializable");
    expect(circularError.cause).toBe(circular);

    const hostile = {
      get message(): string {
        throw new Error("getter exploded");
      },
    };
    const hostileError = await errorFrom(hostile);
    expect(hostileError).toBeInstanceOf(Error);

    const bigint = await errorFrom({ n: 10n });
    expect(bigint.message).toContain("unserializable");
  });

  it("describes primitives and nullish values", async () => {
    expect((await errorFrom(undefined)).message).toContain("undefined");
    expect((await errorFrom(null)).message).toContain("null");
    expect((await errorFrom(404)).message).toContain("404");
  });

  it("truncates very large rejection details", async () => {
    const error = await errorFrom({ blob: "x".repeat(10_000) });
    expect(error.message.length).toBeLessThan(700);
  });
});

describe("empty and invalid input", () => {
  it("supports an empty workflow: ok summary, executor never called", async () => {
    let calls = 0;
    const summary = await runWorkflow(wf([]), () => {
      calls++;
    });
    expect(calls).toBe(0);
    expect(summary).toMatchObject({
      ok: true,
      counts: { succeeded: 0, failed: 0, blocked: 0 },
      startOrder: [],
      results: [],
      maxObservedConcurrency: 0,
    });
  });

  it.each([
    ["a dependency cycle", [["a", ["b"]], ["b", ["a"]]], /cycle/i],
    ["a longer cycle", [["a", []], ["b", ["a", "d"]], ["c", ["b"]], ["d", ["c"]]], /cycle/i],
    ["a self-dependency", [["a", ["a"]]], /cannot depend on itself/i],
    ["an unknown dependency", [["a", ["ghost"]]], /unknown task "ghost"/i],
    ["duplicate task IDs", [["a", []], ["a", []]], /unique/i],
  ] as Array<[string, Array<[string, string[]]>, RegExp]>)(
    "rejects %s before running anything",
    async (_label, spec, message) => {
      let calls = 0;
      await expect(
        runWorkflow(wf(spec), () => {
          calls++;
        }),
      ).rejects.toThrow(message);
      expect(calls).toBe(0);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid concurrency %s",
    async (concurrency) => {
      await expect(
        runWorkflow(wf([["a", []]]), () => "x", { concurrency }),
      ).rejects.toThrow(RangeError);
    },
  );

  it("rejects a non-function executor", async () => {
    await expect(
      runWorkflow(wf([["a", []]]), undefined as unknown as TaskExecutor),
    ).rejects.toThrow(TypeError);
  });
});

describe("malformed workflows at the scheduler boundary", () => {
  const never = () => {
    throw new Error("executor must not run for a malformed workflow");
  };

  it.each([
    ["tasks is not an array", undefined, /tasks array/],
    ["tasks is an object", {}, /tasks array/],
    ["a task is null", [null], /index 0 must be an object/],
    ["a task is a string", ["a"], /index 0 must be an object/],
    ["a task has no id", [{ name: "x", dependencies: [] }], /non-empty string id/],
    ["a task has an empty id", [{ id: "", name: "x", dependencies: [] }], /non-empty string id/],
    ["a task has a numeric id", [{ id: 1, name: "x", dependencies: [] }], /non-empty string id/],
    ["dependencies is null", [{ id: "a", name: "a", dependencies: null }], /invalid dependencies/],
    ["dependencies is a string", [{ id: "a", name: "a", dependencies: "b" }], /invalid dependencies/],
    ["dependencies has a number", [{ id: "a", name: "a", dependencies: [1] }], /invalid dependencies/],
    ["dependencies has a null", [{ id: "a", name: "a", dependencies: [null] }], /invalid dependencies/],
    // eslint-disable-next-line no-sparse-arrays
    ["dependencies is sparse", [{ id: "a", name: "a", dependencies: [, "b"] }], /invalid dependencies/],
  ])("rejects TypeError when %s", async (_label, tasks, message) => {
    await expect(runWorkflow(raw(tasks), never)).rejects.toThrow(TypeError);
    await expect(runWorkflow(raw(tasks), never)).rejects.toThrow(message);
  });

  it("rejects a non-object workflow", async () => {
    await expect(
      runWorkflow(null as unknown as Workflow, never),
    ).rejects.toThrow(TypeError);
  });

  it("treats missing dependencies as none, matching the schema default", async () => {
    const summary = await runWorkflow(
      raw([{ id: "a", name: "a" }, { id: "b", name: "b", dependencies: ["a"] }]),
      (t) => t.id,
    );
    expect(summary.ok).toBe(true);
    expect(summary.startOrder).toEqual(["a", "b"]);
  });

  it("collapses duplicate dependency entries instead of mis-counting them", async () => {
    const summary = await runWorkflow(
      wf([["a", []], ["b", ["a", "a", "a"]]]),
      (t) => t.id,
    );
    expect(summary.ok).toBe(true);
    expect(summary.startOrder).toEqual(["a", "b"]);
  });

  it("does not mutate the caller's workflow", async () => {
    const w = wf([["a", []], ["b", ["a", "a"]]]);
    const snapshot = JSON.stringify(w);
    await runWorkflow(w, (t) => t.id);
    expect(JSON.stringify(w)).toBe(snapshot);
  });
});