import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkflowStorage } from "../../packages/storage/src/index.ts";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://relay:relay_dev_password@localhost:5432/relay_os";

const storage = new PostgresWorkflowStorage(connectionString);

describe("PostgreSQL workflow storage", () => {
  beforeAll(async () => {
    await storage.initialize();
  });

  afterAll(async () => {
    await storage.close();
  });

  it("persists workflows and execution events", async () => {
    const id = `storage-test-${crypto.randomUUID()}`;
    const definition = {
      id,
      name: "Storage integration test",
      tasks: [{ id: "task-1", name: "Example task", dependencies: [] }],
    };

    await storage.saveWorkflow({
      id,
      name: definition.name,
      status: "running",
      definition,
    });

    await storage.appendEvent({
      workflowId: id,
      taskId: "task-1",
      eventType: "task.started",
      payload: { attempt: 1 },
    });

    const workflow = await storage.getWorkflow(id);
    const events = await storage.getEvents(id);

    expect(workflow?.id).toBe(id);
    expect(workflow?.status).toBe("running");
    expect(workflow?.definition).toEqual(definition);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("task.started");
    expect(events[0]?.payload).toEqual({ attempt: 1 });
  });
});