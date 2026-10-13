import { getExecutionOrder } from "./dag.js";
import type { Workflow, WorkflowTask } from "./index.js";

/** Terminal outcome of a task within one scheduler run. */
export type TaskOutcome = "succeeded" | "failed" | "blocked";

interface TaskTiming {
    /** Logical sequence numbers (not wall-clock), so tests and traces are deterministic. */
    startedAt: number;
    finishedAt: number;
}

export type TaskResult<T = unknown> =
    | ({ taskId: string; outcome: "succeeded"; value: T } & TaskTiming)
    | ({ taskId: string; outcome: "failed"; error: Error } & TaskTiming)
    /** Never started. `blockedBy` lists the root failed tasks upstream, sorted. */
    | { taskId: string; outcome: "blocked"; blockedBy: string[] };

export interface ExecutionSummary<T = unknown> {
    workflowId: string;
    /** True only if every task succeeded (vacuously true for an empty workflow). */
    ok: boolean;
    counts: Record<TaskOutcome, number>;
    /**
     * Order in which tasks were started.
     *
     * This is NOT a pure function of the graph. Dependencies and the concurrency
     * limit are always respected, and tasks that are ready at the same moment start
     * in declared task order, but *when* a task becomes ready depends on the order in
     * which running tasks complete, and that is decided by the executor's timing. With
     * a limited number of slots, completion order can therefore change which newly
     * ready task is started next. Given the same graph and the same completion order,
     * the start order is identical.
     */
    startOrder: string[];
    /** Highest number of tasks running at once. */
    maxObservedConcurrency: number;
    /** One result per task, in the workflow's declared task order. */
    results: TaskResult<T>[];
}

export type TaskExecutor<T = unknown> = (task: WorkflowTask) => Promise<T> | T;

export interface RunWorkflowOptions {
    /** Maximum tasks running at once. Integer >= 1. Default 4. */
    concurrency?: number;
}

export const DEFAULT_CONCURRENCY = 4;

/** Longest rejected-value description embedded in an Error message. */
const MAX_DETAIL_LENGTH = 500;

type Settled<T> =
    | { taskId: string; ok: true; value: T }
    | { taskId: string; ok: false; error: Error };

interface NormalizedTask {
    /** The caller's own task object; this is what the executor receives. */
    original: WorkflowTask;
    id: string;
    /** De-duplicated dependency IDs. */
    dependencies: string[];
}

function truncate(text: string): string {
    return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

function withCause(error: Error, cause: unknown): Error {
    Object.defineProperty(error, "cause", {
        value: cause,
        writable: true,
        configurable: true,
        enumerable: false,
    });
    return error;
}

/**
 * Converts any rejection reason into an Error without throwing.
 * - Error instances pass through unchanged.
 * - Strings become the message.
 * - Objects with a non-empty string `message` keep that message (and a string
 *   `name`, if present); otherwise their JSON form is embedded in the message.
 * - Anything else is described with String().
 * Converted errors keep the original value as `cause`.
 */
function toError(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    if (typeof reason === "string") return new Error(reason);

    try {
        if (typeof reason === "object" && reason !== null) {
            const { message, name } = reason as { message?: unknown; name?: unknown };
            if (typeof message === "string" && message.length > 0) {
                const error = new Error(message);
                if (typeof name === "string" && name.length > 0) error.name = name;
                return withCause(error, reason);
            }
            let detail: string | undefined;
            try {
                detail = JSON.stringify(reason);
            } catch {
                detail = undefined; // circular structure, BigInt, throwing toJSON, ...
            }
            return withCause(
                new Error(
                    `Task rejected with non-Error object: ${truncate(detail ?? "[unserializable object]")}`,
                ),
                reason,
            );
        }
        return withCause(
            new Error(`Task rejected with non-Error value: ${truncate(String(reason))}`),
            reason,
        );
    } catch {
        // Hostile values (throwing getters, revoked proxies, ...). Never throw from here.
        return new Error("Task rejected with an unreadable value.");
    }
}

/**
 * Validates the shape of the workflow at the scheduler boundary and returns
 * normalized tasks. Malformed input throws a TypeError instead of being accepted.
 *
 * Normalization is limited to cases that cannot change meaning:
 * - `dependencies` missing (undefined) is treated as [], matching the schema default;
 * - duplicate entries in `dependencies` are collapsed.
 *
 * Semantic checks (unknown dependency, self-dependency, duplicate task IDs, cycles)
 * are left to getExecutionOrder.
 */
function normalizeTasks(workflow: Workflow): NormalizedTask[] {
    const rawWorkflow: unknown = workflow;
    if (
        typeof rawWorkflow !== "object" ||
        rawWorkflow === null ||
        !Array.isArray((rawWorkflow as { tasks?: unknown }).tasks)
    ) {
        throw new TypeError("Workflow must be an object with a tasks array.");
    }

    const rawTasks = Array.from((rawWorkflow as { tasks: unknown[] }).tasks);

    return rawTasks.map((entry, index): NormalizedTask => {
        if (typeof entry !== "object" || entry === null) {
            throw new TypeError(`Task at index ${index} must be an object.`);
        }
        const { id, dependencies } = entry as { id?: unknown; dependencies?: unknown };

        if (typeof id !== "string" || id.length === 0) {
            throw new TypeError(`Task at index ${index} must have a non-empty string id.`);
        }
        if (dependencies === undefined) {
            return { original: entry as WorkflowTask, id, dependencies: [] };
        }
        if (!Array.isArray(dependencies)) {
            throw new TypeError(`Task "${id}" has invalid dependencies: expected an array of strings.`);
        }
        const list: unknown[] = Array.from(dependencies); // turns sparse holes into undefined
        if (!list.every((dep): dep is string => typeof dep === "string")) {
            throw new TypeError(`Task "${id}" has invalid dependencies: expected an array of strings.`);
        }
        return { original: entry as WorkflowTask, id, dependencies: [...new Set(list)] };
    });
}

/**
 * Runs a workflow's tasks respecting dependencies and a concurrency bound.
 *
 * Contract:
 * - A task starts only after every dependency has succeeded.
 * - At most `concurrency` tasks run at once.
 * - Tasks that are ready at the same moment start in declared task order. See
 *   `ExecutionSummary.startOrder` for what that does and does not guarantee.
 * - A failed task blocks all of its transitive dependents; unrelated branches and
 *   work already in flight finish normally.
 * - Executor throws and rejections (including non-Error values) become `failed`
 *   results and never leave the scheduler waiting.
 * - An empty `tasks` array is supported and yields an empty, `ok: true` summary
 *   without calling the executor. (`WorkflowSchema` requires at least one task,
 *   but that rule is enforced by `createWorkflow`, not here.)
 *
 * Rejects before running anything when:
 * - the workflow is malformed (TypeError: bad tasks array, task, id, dependencies);
 * - the workflow is semantically invalid: duplicate IDs, unknown dependency,
 *   self-dependency, or a cycle (Error from getExecutionOrder);
 * - `execute` is not a function (TypeError) or `concurrency` is not an integer >= 1
 *   (RangeError).
 *
 * The executor receives the caller's original task object.
 */
export async function runWorkflow<T = unknown>(
    workflow: Workflow,
    execute: TaskExecutor<T>,
    options: RunWorkflowOptions = {},
): Promise<ExecutionSummary<T>> {
    if (typeof execute !== "function") {
        throw new TypeError("execute must be a function.");
    }
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError(
            `concurrency must be an integer >= 1, received ${String(concurrency)}.`,
        );
    }

    const tasks = normalizeTasks(workflow);
    const tasksById = new Map(tasks.map((task) => [task.id, task]));

    // Semantic validation (duplicates, unknown deps, self-deps, cycles) is delegated to
    // the existing validator, run on the normalized copy it can safely iterate.
    const topologicalIds = getExecutionOrder({
        ...workflow,
        tasks: tasks.map((task) => ({ ...task.original, id: task.id, dependencies: task.dependencies })),
    }).map((task) => task.id);

    const finished = new Map<string, TaskResult<T>>();
    const running = new Set<string>();
    const startedAt = new Map<string, number>();
    const startOrder: string[] = [];
    let tick = 0;
    let maxObservedConcurrency = 0;

    // Completion queue. Every task promise gets exactly one pair of handlers, attached
    // at launch. The main loop never attaches handlers to task promises; it waits on a
    // single signal that the handlers resolve.
    const completions: Settled<T>[] = [];
    let signal: (() => void) | undefined;

    const enqueue = (settled: Settled<T>): void => {
        completions.push(settled);
        const wake = signal;
        signal = undefined;
        wake?.();
    };

    const waitForCompletion = async (): Promise<void> => {
        if (completions.length > 0) return;
        await new Promise<void>((resolve) => {
            signal = resolve;
        });
    };

    const launch = (task: NormalizedTask): void => {
        startOrder.push(task.id);
        startedAt.set(task.id, tick++);
        running.add(task.id);
        maxObservedConcurrency = Math.max(maxObservedConcurrency, running.size);

        // The executor runs synchronously inside the Promise constructor, so a
        // synchronous throw becomes a rejection. Both handlers only enqueue and
        // toError never throws, so this chain cannot produce an unhandled rejection.
        new Promise<T>((resolve) => resolve(execute(task.original))).then(
            (value) => enqueue({ taskId: task.id, ok: true, value }),
            (reason: unknown) => enqueue({ taskId: task.id, ok: false, error: toError(reason) }),
        );
    };

    const record = (settled: Settled<T>): void => {
        running.delete(settled.taskId);
        const base = {
            taskId: settled.taskId,
            startedAt: startedAt.get(settled.taskId)!,
            finishedAt: tick++,
        };
        finished.set(
            settled.taskId,
            settled.ok
                ? { ...base, outcome: "succeeded", value: settled.value }
                : { ...base, outcome: "failed", error: settled.error },
        );
    };

    const isStartable = (task: NormalizedTask): boolean =>
        !finished.has(task.id) &&
        !running.has(task.id) &&
        task.dependencies.every((dep) => finished.get(dep)?.outcome === "succeeded");

    while (true) {
        // Fill free slots in declared order.
        for (const task of tasks) {
            if (running.size >= concurrency) break;
            if (isStartable(task)) launch(task);
        }

        if (running.size === 0) break;

        await waitForCompletion();
        // Handle everything that has completed so far before refilling, so tasks that
        // finished together are treated together.
        while (completions.length > 0) record(completions.shift()!);
    }

    // Nothing is running and nothing is startable, so every unfinished task has a
    // failed or blocked prerequisite. Resolve them in topological order so each
    // task's root causes are already known.
    for (const id of topologicalIds) {
        if (finished.has(id)) continue;

        const roots = new Set<string>();
        for (const dep of tasksById.get(id)!.dependencies) {
            const result = finished.get(dep);
            if (result?.outcome === "failed") roots.add(dep);
            else if (result?.outcome === "blocked") result.blockedBy.forEach((root) => roots.add(root));
        }

        if (roots.size === 0) {
            throw new Error(`Scheduler invariant violated: task "${id}" was neither run nor blocked.`);
        }
        finished.set(id, { taskId: id, outcome: "blocked", blockedBy: [...roots].sort() });
    }

    const results = tasks.map((task) => finished.get(task.id)!);
    const counts: Record<TaskOutcome, number> = { succeeded: 0, failed: 0, blocked: 0 };
    for (const result of results) counts[result.outcome]++;

    return {
        workflowId: workflow.id,
        ok: counts.failed === 0 && counts.blocked === 0,
        counts,
        startOrder,
        maxObservedConcurrency,
        results,
    };
}