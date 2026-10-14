
import { runWorkflow } from "./scheduler.ts";
import type { Workflow } from "./index.ts";
import type { WorkflowStorage } from "../../storage/src/interfaces/storage.ts";
import { StorageEventRecorder } from "../../storage/src/postgres/event-recorder.ts";

export async function executeAndPersistWorkflow(
    workflow: Workflow,
    storage: WorkflowStorage,
): Promise<Awaited<ReturnType<typeof runWorkflow>>> {
    await storage.saveWorkflow({
        id: workflow.id,
        name: workflow.name,
        status: "running",
        definition: workflow,
    });

    const recorder = new StorageEventRecorder(storage);

    try {
        const summary = await runWorkflow(
            workflow,
            async (task) => ({
                taskId: task.id,
                message: `Task ${task.name} executed by RelayOS.`,
            }),
            { recorder },
        );

        await storage.saveWorkflow({
            id: workflow.id,
            name: workflow.name,
            status: summary.ok ? "succeeded" : "failed",
            definition: workflow,
        });

        return summary;
    } catch (error) {
        await storage.saveWorkflow({
            id: workflow.id,
            name: workflow.name,
            status: "failed",
            definition: workflow,
        });

        throw error;
    }
}