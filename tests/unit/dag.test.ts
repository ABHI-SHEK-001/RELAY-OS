
import { describe, expect, it } from "vitest";
import { getExecutionOrder } from "../../packages/core/src/dag.js";
import type { Workflow } from "../../packages/core/src/index.ts";

describe("getExecutionOrder", () => {
    it("places dependencies before dependent tasks", () => {
        const workflow: Workflow = {
            id: "wf-1",
            name: "Pipeline",
            tasks: [
                { id: "publish", name: "Publish", dependencies: ["build"] },
                { id: "build", name: "Build", dependencies: ["fetch"] },
                { id: "fetch", name: "Fetch", dependencies: [] },
            ],
        };

        const order = getExecutionOrder(workflow).map((task) => task.id);

        expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("build"));
        expect(order.indexOf("build")).toBeLessThan(order.indexOf("publish"));
    });

    it("rejects a dependency cycle", () => {
        const workflow: Workflow = {
            id: "wf-2",
            name: "Cyclic pipeline",
            tasks: [
                { id: "a", name: "A", dependencies: ["b"] },
                { id: "b", name: "B", dependencies: ["a"] },
            ],
        };

        expect(() => getExecutionOrder(workflow)).toThrow(
            "Workflow contains a dependency cycle.",
        );
    });
});
