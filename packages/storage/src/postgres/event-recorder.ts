import type {
  SchedulerEvent,
  SchedulerEventRecorder,
} from "../../../core/src/events.ts";
import type { WorkflowStorage } from "../interfaces/storage.ts";

/**
 * Adapts core scheduler events to the existing storage interface.
 *
 * The workflow must be saved before recording its events because the
 * PostgreSQL execution_events table references workflows(id).
 */
export class StorageEventRecorder implements SchedulerEventRecorder {
  constructor(private readonly storage: WorkflowStorage) {}

  async record(event: SchedulerEvent): Promise<void> {
    await this.storage.appendEvent({
      workflowId: event.workflowId,
      taskId: event.taskId,
      eventType: event.type,
      payload: {
        ...event.payload,
        sequence: event.sequence,
        occurredAt: event.occurredAt.toISOString(),
      },
    });
  }
}