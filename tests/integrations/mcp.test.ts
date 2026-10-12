import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

describe("RelayOS MCP integration", () => {
    let client: Client;
    let transport: StreamableHTTPClientTransport;

    beforeAll(async () => {
        client = new Client(
            { name: "relay-os-test-client", version: "1.0.0" },
            {
                versionNegotiation: {
                    mode: { pin: "2026-07-28" },
                },
            },
        );

        transport = new StreamableHTTPClientTransport(
            new URL("http://localhost:3000/mcp"),
        );

        await client.connect(transport);
    });

    afterAll(async () => {
        await client.close();
    });

    it("discovers the relay_ping tool", async () => {
        const result = await client.listTools();

        expect(result.tools.some((tool) => tool.name === "relay_ping")).toBe(true);
    });

    it("calls relay_ping and receives a response", async () => {
        const result = await client.callTool({
            name: "relay_ping",
            arguments: { message: "integration test" },
        });

        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "text",
                    text: expect.stringContaining("integration test"),
                }),
            ]),
        );
    });


    it("creates a workflow through MCP", async () => {
        const result = await client.callTool({
            name: "create_workflow",
            arguments: {
                name: "Demo pipeline",
                tasks: [
                    {
                        id: "fetch",
                        name: "Fetch data",
                        dependencies: [],
                    },
                    {
                        id: "process",
                        name: "Process data",
                        dependencies: ["fetch"],
                    },
                ],
            },
        });

        expect(result.isError).not.toBe(true);

        const content = result.content.find((item) => item.type === "text");
        expect(content?.type).toBe("text");

        if (content?.type !== "text") {
            throw new Error("Expected workflow details in text content");
        }

        const workflow = JSON.parse(content.text);

        expect(workflow.id).toBeTruthy();
        expect(workflow.name).toBe("Demo pipeline");
        expect(workflow.tasks).toHaveLength(2);
    });

    it("rejects a workflow with an unknown dependency", async () => {
        const result = await client.callTool({
            name: "create_workflow",
            arguments: {
                name: "Invalid pipeline",
                tasks: [
                    {
                        id: "process",
                        name: "Process data",
                        dependencies: ["missing-task"],
                    },
                ],
            },
        });

        expect(result.isError).toBe(true);
    });


    it("lists workflows created through MCP", async () => {
        const created = await client.callTool({
            name: "create_workflow",
            arguments: {
                name: "List test workflow",
                tasks: [
                    {
                        id: "start",
                        name: "Start task",
                        dependencies: [],
                    },
                ],
            },
        });

        expect(created.isError).not.toBe(true);

        const result = await client.callTool({
            name: "list_workflows",
            arguments: {},
        });

        expect(result.isError).not.toBe(true);

        const content = result.content.find((item) => item.type === "text");
        expect(content?.type).toBe("text");

        if (content?.type !== "text") {
            throw new Error("Expected workflow list in text content");
        }

        const workflows = JSON.parse(content.text);

        expect(
            workflows.some(
                (workflow: { name: string }) =>
                    workflow.name === "List test workflow",
            ),
        ).toBe(true);
    });


    it("rejects a workflow containing a dependency cycle", async () => {
        const result = await client.callTool({
            name: "create_workflow",
            arguments: {
                name: "Cyclic pipeline",
                tasks: [
                    { id: "a", name: "Task A", dependencies: ["b"] },
                    { id: "b", name: "Task B", dependencies: ["a"] },
                ],
            },
        });

        expect(result.isError).toBe(true);

        const content = result.content.find((item) => item.type === "text");

        expect(content?.type).toBe("text");

        if (content?.type === "text") {
            expect(content.text).toContain("dependency cycle");
        }
    });


});