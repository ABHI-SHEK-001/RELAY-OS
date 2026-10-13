import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import type {
  ExecutionEvent,
  StoredWorkflow,
  WorkflowStorage,
} from "../interfaces/storage.ts";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

interface WorkflowRow {
  id: string;
  name: string;
  status: StoredWorkflow["status"];
  definition: unknown;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapWorkflow(row: WorkflowRow): StoredWorkflow {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    definition: row.definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): ExecutionEvent {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export class PostgresWorkflowStorage implements WorkflowStorage {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    const schema = await readFile(schemaPath, "utf8");
    await this.pool.query(schema);
  }

  async saveWorkflow(
    workflow: Pick<
      StoredWorkflow,
      "id" | "name" | "status" | "definition"
    >
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO workflows (id, name, status, definition)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         definition = EXCLUDED.definition,
         updated_at = NOW()`,
      [
        workflow.id,
        workflow.name,
        workflow.status,
        JSON.stringify(workflow.definition),
      ],
    );
  }

  async getWorkflow(id: string): Promise<StoredWorkflow | null> {
    const result = await this.pool.query<WorkflowRow>(
      `SELECT id, name, status, definition, created_at, updated_at
       FROM workflows WHERE id = $1`,
      [id],
    );

    return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
  }

  async listWorkflows(): Promise<StoredWorkflow[]> {
    const result = await this.pool.query<WorkflowRow>(
      `SELECT id, name, status, definition, created_at, updated_at
       FROM workflows ORDER BY created_at DESC`,
    );

    return result.rows.map(mapWorkflow);
  }

  async appendEvent(
    event: Pick<
      ExecutionEvent,
      "workflowId" | "taskId" | "eventType" | "payload"
    >
  ): Promise<ExecutionEvent> {
    const result = await this.pool.query<EventRow>(
      `INSERT INTO execution_events
         (id, workflow_id, task_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, workflow_id, task_id, event_type, payload, created_at`,
      [
        randomUUID(),
        event.workflowId,
        event.taskId,
        event.eventType,
        JSON.stringify(event.payload),
      ],
    );

    return mapEvent(result.rows[0]!);
  }

  async getEvents(workflowId: string): Promise<ExecutionEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, workflow_id, task_id, event_type, payload, created_at
       FROM execution_events
       WHERE workflow_id = $1
       ORDER BY created_at ASC, id ASC`,
      [workflowId],
    );

    return result.rows.map(mapEvent);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}