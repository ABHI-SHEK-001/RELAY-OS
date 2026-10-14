
import type { TaskResult } from "./scheduler.ts";

export type SchedulerEventType =
  | "workflow.started"
  | "workflow.completed"
  | "task.started"
  | "task.succeeded"
  | "task.failed"
  | "task.blocked";

export interface SchedulerEvent {
  type: SchedulerEventType;
  workflowId: string;
  taskId: string | null;
  sequence: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export interface SchedulerEventRecorder {
  record(event: SchedulerEvent): Promise<void>;
}

export interface EventPersistenceErrorDetails {
  workflowId: string;
  eventType: SchedulerEventType;
  taskId: string | null;
  sequence: number;
  cause: unknown;
  results: TaskResult[];
}

export class EventPersistenceError extends Error {
  readonly event: SchedulerEvent;
  readonly cause: unknown;

  constructor(event: SchedulerEvent, cause: unknown) {
    const reason =
      cause instanceof Error ? cause.message : String(cause);

    super(
      `Failed to persist "${event.type}" event for workflow "${event.workflowId}": ${reason}`,
    );

    this.name = "EventPersistenceError";
    this.event = event;
    this.cause = cause;
  }
}