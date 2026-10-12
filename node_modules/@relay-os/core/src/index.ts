
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getExecutionOrder } from "./dag.js";

export const WorkflowTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
});

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tasks: z.array(WorkflowTaskSchema).min(1),
});

export type WorkflowTask = z.infer<typeof WorkflowTaskSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

const workflows = new Map<string, Workflow>();

export function createWorkflow(
  input: Omit<Workflow, "id">,
): Workflow {
  const parsed = WorkflowSchema.omit({ id: true }).parse(input);

  const taskIds = new Set(parsed.tasks.map((task) => task.id));

  if (taskIds.size !== parsed.tasks.length) {
    throw new Error("Task IDs must be unique.");
  }

  for (const task of parsed.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        throw new Error(
          `Task "${task.id}" depends on unknown task "${dependency}".`,
        );
      }

      if (dependency === task.id) {
        throw new Error(`Task "${task.id}" cannot depend on itself.`);
      }
    }
  }

  const workflow: Workflow = {
    id: randomUUID(),
    ...parsed,
  };

  getExecutionOrder(workflow);

  workflows.set(workflow.id, workflow);

  return workflow;
}

export function getWorkflow(id: string): Workflow | undefined {
  return workflows.get(id);
}

export function listWorkflows(): Workflow[] {
  return [...workflows.values()];
}
