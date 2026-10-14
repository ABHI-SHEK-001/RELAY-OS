import { describe, expect, it, vi } from "vitest";
import {
    runWorkflow,
    type Workflow,
} from "../../packages/core/src/index.js";
import {
    EventPersistenceError,
    type SchedulerEvent,
    type SchedulerEventRecorder,
} from "../../packages/core/src/events.ts";

function workflow(tasks: Array<{ id: string; dependencies: string[] }>): Workflow {
    return {
        id: "wf-events-test",
        name: "Event persistence test",
        tasks: tasks.map((task) => ({
            ...task,
            name: task.id,
        })),
    };
}

function createRecorder(
    onRecord?: (event: SchedulerEvent) => Promise<void>,
) {
    const events: SchedulerEvent[] = [];

    const recorder: SchedulerEventRecorder = {
        async record(event) {
            events.push(event);
            await onRecord?.(event);
        },
    };

    return { recorder, events };
}

describe("scheduler event persistence", () => {
    it("persists events in order with sequential IDs and deterministic timestamps", async () => {
        const { recorder, events } = createRecorder();
        let clock = 0;

        const summary = await runWorkflow(
            workflow([{ id: "a", dependencies: [] }, { id: "b", dependencies: ["a"] }]),
            (task) => task.id,
            {
                recorder,
                now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
            },
        );

        expect(summary.ok).toBe(true);
        expect(events.map((event) => event.type)).toEqual([
            "workflow.started",
            "task.started",
            "task.succeeded",
            "task.started",
            "task.succeeded",
            "workflow.completed",
        ]);

        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(events.every((event) => event.workflowId === "wf-events-test")).toBe(true);
        expect(events.map((event) => event.occurredAt.getTime())).toEqual(
            [...events]
                .map((event) => event.occurredAt.getTime())
                .sort((a, b) => a - b),
        );
    });

    it("does not execute a task when its start event cannot be persisted", async () => {
        const execute = vi.fn((task: { id: string }) => task.id);
        const { recorder } = createRecorder(async (event) => {
            if (event.type === "task.started") {
                throw new Error("database unavailable");
            }
        });

        await expect(
            runWorkflow(
                workflow([{ id: "a", dependencies: [] }]),
                execute,
                { recorder },
            ),
        ).rejects.toMatchObject({
            name: "EventPersistenceError",
            event: { type: "task.started", taskId: "a" },
        });

        expect(execute).not.toHaveBeenCalled();
    });

    it("does not start a dependent task until the dependency event is persisted", async () => {
        let releasePersistence!: () => void;
        let startedPersistence!: () => void;

        const persistenceStarted = new Promise<void>((resolve) => {
            startedPersistence = resolve;
        });

        const persistenceGate = new Promise<void>((resolve) => {
            releasePersistence = resolve;
        });

        const executed: string[] = [];

        const { recorder, events } = createRecorder(async (event) => {
            if (event.type === "task.succeeded" && event.taskId === "a") {
                startedPersistence();
                await persistenceGate;
            }
        });

        const run = runWorkflow(
            workflow([
                { id: "a", dependencies: [] },
                { id: "b", dependencies: ["a"] },
            ]),
            (task) => {
                executed.push(task.id);
                return task.id;
            },
            { recorder },
        );

        await persistenceStarted;

        expect(executed).toEqual(["a"]);
        expect(events.some((event) => event.type === "task.started" && event.taskId === "b")).toBe(false);

        releasePersistence();

        const summary = await run;

        expect(summary.ok).toBe(true);
        expect(executed).toEqual(["a", "b"]);
    });

    it("records failed and blocked tasks before workflow completion", async () => {
        const { recorder, events } = createRecorder();

        const summary = await runWorkflow(
            workflow([
                { id: "a", dependencies: [] },
                { id: "b", dependencies: ["a"] },
            ]),
            (task) => {
                if (task.id === "a") throw new Error("task failed");
                return task.id;
            },
            { recorder },
        );

        expect(summary.ok).toBe(false);
        expect(events.map((event) => event.type)).toEqual([
            "workflow.started",
            "task.started",
            "task.failed",
            "task.blocked",
            "workflow.completed",
        ]);

        expect(events.find((event) => event.type === "task.blocked")).toMatchObject({
            taskId: "b",
            payload: { blockedBy: ["a"] },
        });
    });

    it("rejects if workflow completion cannot be persisted", async () => {
        const { recorder } = createRecorder(async (event) => {
            if (event.type === "workflow.completed") {
                throw new Error("completion write failed");
            }
        });

        await expect(
            runWorkflow(
                workflow([{ id: "a", dependencies: [] }]),
                (task) => task.id,
                { recorder },
            ),
        ).rejects.toBeInstanceOf(EventPersistenceError);
    });
});
