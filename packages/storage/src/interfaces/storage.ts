
export type WorkflowStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";

export interface StoredWorkflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  definition: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionEvent {
  id: string;
  workflowId: string;
  taskId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface WorkflowStorage {
  initialize(): Promise<void>;

  saveWorkflow(
    workflow: Pick<StoredWorkflow, "id" | "name" | "status" | "definition">
  ): Promise<void>;

  getWorkflow(id: string): Promise<StoredWorkflow | null>;

  listWorkflows(): Promise<StoredWorkflow[]>;

  appendEvent(
    event: Pick<ExecutionEvent, "workflowId" | "taskId" | "eventType" | "payload">
  ): Promise<ExecutionEvent>;

  getEvents(workflowId: string): Promise<ExecutionEvent[]>;

  close(): Promise<void>;
}