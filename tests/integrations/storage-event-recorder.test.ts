import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    PostgresWorkflowStorage,
    StorageEventRecorder,
} from "../../packages/storage/src/index.ts";
import type { SchedulerEvent } from "../../packages/core/src/events.ts";
import { randomUUID } from "node:crypto";
import { runWorkflow } from "../../packages/core/src/index.ts";

const connectionString =
    process.env.DATABASE_URL ??
    "postgresql://relay:relay_dev_password@localhost:5432/relay_os";

const storage = new PostgresWorkflowStorage(connectionString);

describe("PostgreSQL scheduler event recorder", () => {
    beforeAll(async () => {
        await storage.initialize();
    });

    afterAll(async () => {
        await storage.close();
    });

    it("persists scheduler event types, sequence numbers, and timestamps", async () => {
        const workflowId = `recorder-test-${crypto.randomUUID()}`;

        await storage.saveWorkflow({
            id: workflowId,
            name: "Event recorder integration test",
            status: "running",
            definition: {
                id: workflowId,
                name: "Event recorder integration test",
                tasks: [{ id: "task-1", name: "Task 1", dependencies: [] }],
            },
        });

        const recorder = new StorageEventRecorder(storage);
        const occurredAt = new Date("2026-10-14T13:00:00.000Z");

        const event: SchedulerEvent = {
            workflowId,
            taskId: "task-1",
            type: "task.started",
            sequence: 2,
            occurredAt,
            payload: { attempt: 1 },
        };

        await recorder.record(event);

        const stored = await storage.getEvents(workflowId);

        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
            workflowId,
            taskId: "task-1",
            eventType: "task.started",
            payload: {
                attempt: 1,
                sequence: 2,
                occurredAt: occurredAt.toISOString(),
            },
        });
        expect(stored[0]?.id).toBeTruthy();
        expect(stored[0]?.createdAt).toBeInstanceOf(Date);
    });

    it("propagates storage errors to the scheduler recorder caller", async () => {
        const failingStorage = {
            appendEvent: async () => {
                throw new Error("simulated database failure");
            },
        } as unknown as ConstructorParameters<typeof StorageEventRecorder>[0];

        const recorder = new StorageEventRecorder(failingStorage);

        await expect(
            recorder.record({
                workflowId: "missing-workflow",
                taskId: null,
                type: "workflow.started",
                sequence: 1,
                occurredAt: new Date("2026-10-14T13:00:00.000Z"),
                payload: {},
            }),
        ).rejects.toThrow("simulated database failure");
    });


    it("records a complete scheduler run in PostgreSQL", async () => {
        const workflowId = `e2e-recorder-${crypto.randomUUID()}`;

        const definition = {
            id: workflowId,
            name: "End-to-end event test",
            tasks: [
                { id: "a", name: "Task A", dependencies: [] },
                { id: "b", name: "Task B", dependencies: ["a"] },
            ],
        };

        await storage.saveWorkflow({
            id: workflowId,
            name: definition.name,
            status: "running",
            definition,
        });

        const recorder = new StorageEventRecorder(storage);

        const summary = await runWorkflow(
            definition,
            (task) => `${task.id}-done`,
            { recorder },
        );

        const events = await storage.getEvents(workflowId);

        expect(summary.ok).toBe(true);
        expect(summary.startOrder).toEqual(["a", "b"]);

        expect(events.map((event) => event.eventType)).toEqual([
            "workflow.started",
            "task.started",
            "task.succeeded",
            "task.started",
            "task.succeeded",
            "workflow.completed",
        ]);

        expect(events.map((event) => event.payload.sequence)).toEqual([
            1, 2, 3, 4, 5, 6,
        ]);

        expect(events.every((event) => event.workflowId === workflowId)).toBe(true);
    });

});
