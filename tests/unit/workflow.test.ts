import { describe, expect, it } from "vitest";
import { WorkflowSchema } from '../../packages/core/src/index.js'

describe("WorkflowSchema", () => {
  it("accepts a valid workflow", () => {
    const workflow = {
      id: "wf-1",
      name: "Data pipeline",
      tasks: [
        {
          id: "fetch",
          name: "Fetch data",
          dependencies: [],
        },
      ],
    };

    expect(WorkflowSchema.safeParse(workflow).success).toBe(true);
  });

  it("rejects a workflow without tasks", () => {
    const workflow = {
      id: "wf-2",
      name: "Empty workflow",
      tasks: [],
    };

    expect(WorkflowSchema.safeParse(workflow).success).toBe(false);
  });
});
