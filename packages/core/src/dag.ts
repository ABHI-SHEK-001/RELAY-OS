
import type { Workflow, WorkflowTask } from "./index.ts";

/**
 * Validates dependencies and returns tasks in executable order.
 * A task always appears after all its dependencies.
 */
export function getExecutionOrder(workflow: Workflow): WorkflowTask[] {
    const tasksById = new Map(
        workflow.tasks.map((task) => [task.id, task]),
    );

    if (tasksById.size !== workflow.tasks.length) {
        throw new Error("Task IDs must be unique.");
    }

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const task of workflow.tasks) {
        inDegree.set(task.id, 0);
        dependents.set(task.id, []);
    }

    for (const task of workflow.tasks) {
        for (const dependency of task.dependencies) {
            if (!tasksById.has(dependency)) {
                throw new Error(
                    `Task "${task.id}" depends on unknown task "${dependency}".`,
                );
            }

            if (dependency === task.id) {
                throw new Error(`Task "${task.id}" cannot depend on itself.`);
            }

            inDegree.set(task.id, inDegree.get(task.id)! + 1);
            dependents.get(dependency)!.push(task.id);
        }
    }

    // Start with tasks that have no dependencies.
    const ready = workflow.tasks
        .filter((task) => inDegree.get(task.id) === 0)
        .map((task) => task.id);

    const order: WorkflowTask[] = [];

    while (ready.length > 0) {
        const id = ready.shift()!;
        order.push(tasksById.get(id)!);

        for (const dependentId of dependents.get(id)!) {
            const remaining = inDegree.get(dependentId)! - 1;
            inDegree.set(dependentId, remaining);

            if (remaining === 0) {
                ready.push(dependentId);
            }
        }
    }

    if (order.length !== workflow.tasks.length) {
        throw new Error("Workflow contains a dependency cycle.");
    }

    return order;
}
