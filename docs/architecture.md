# RelayOS Architecture

## Product Goal

RelayOS is a durable, dependency-aware agentic workflow runtime that plans, executes, verifies, and recovers complex tasks.

Its core differentiator is reliable execution with verifiable outcomes and recovery from partial failures.

## Current Architecture

- `apps/api`: HTTP API and MCP endpoint.
- `packages/core`: Workflow schemas, workflow creation, DAG scheduling, and execution orchestration.
- `packages/core/src/dag.ts`: Dependency validation and execution ordering.
- `packages/core/src/scheduler.ts`: Dependency-aware task execution, bounded concurrency, failure handling, blocked-task handling, and optional scheduler event recording.
- `packages/core/src/events.ts`: Scheduler event types, event recorder interface, and persistence error representation.
- `packages/core/src/workflow-runner.ts`: Workflow execution wrapper that records workflow state and connects scheduler events to persistent storage. Its current task executor is a placeholder, not a real-world tool executor.
- `packages/mcp-server`: MCP server construction and workflow-related tools.
- `packages/storage`: Storage interfaces and PostgreSQL implementation.
- `packages/storage/src/postgres/postgres-storage.ts`: PostgreSQL-backed workflow and execution-event storage.
- `packages/storage/src/postgres/event-recorder.ts`: Adapter that translates scheduler events into persisted execution events.

## Storage and Persistence

PostgreSQL is the persistent database for local development and workflow execution records. Storage code is organized in a dedicated package.

Docker Compose is used for local database development.

The current persistence implementation includes:

- Saving workflow definitions and statuses.
- Appending execution events to PostgreSQL.
- Recording scheduler lifecycle events through `StorageEventRecorder`.
- Persisting event sequence numbers and timestamps in event payloads.
- Retrieving workflow records and their execution events.

Scheduler event recording is optional. When configured, the scheduler records workflow and task lifecycle events. Persistence errors are surfaced to the caller, and the scheduler stops launching new tasks after a journal failure while allowing already-running tasks to settle.

**Important:** Durable event recording is implemented, but complete restart recovery and resumption of interrupted workflows are not yet verified.

Kubernetes deployment will be considered after application behavior and persistence/recovery guarantees are verified.

## Execution Principles

1. Dependencies must be validated before execution.
2. Cyclic workflows and missing dependencies must be rejected.
3. Independent tasks may execute concurrently within a configured limit.
4. Failed prerequisites must block dependent tasks.
5. Persistent state is intended to be the source of truth for execution and recovery.
6. The planner proposes actions; the executor enforces policy.
7. The verifier checks evidence from actual execution.
8. Scheduler events should provide an auditable history of workflow execution.
9. Real tool execution must use explicit permissions and approval gates where required.

## Architecture Decisions

- Use a TypeScript monorepo with npm workspaces.
- Expose workflow capabilities through an MCP server.
- Keep storage interfaces and PostgreSQL implementation in a dedicated package.
- Use PostgreSQL for durable workflow and event records.
- Use dependency-aware, bounded-concurrency scheduling.
- Record scheduler events through an adapter rather than embedding PostgreSQL operations directly into scheduler logic.
- Prefer deterministic execution and automated tests before introducing model-driven planning.
- Introduce Kafka and Kubernetes only when their behavior can be tested meaningfully.

## Current Limitations and Remaining Work

- Workflow creation and listing in the core currently use an in-memory map; persistence of workflow records does not yet establish fully database-backed workflow discovery.
- Scheduler event persistence is implemented, but recovery and resumption after process restart are not yet verified.
- The current workflow runner uses a placeholder task executor; real tool execution is not yet implemented.
- A tool registry and allowlisted workspace and test-runner tools remain to be implemented.
- Permission enforcement and approval gates remain to be integrated with real tool execution.
- The planner, outcome verifier, temporal memory, and compensation for failed multi-step workflows remain unfinished.
- Bedrock runtime integration is not yet verified.
- Kafka and Kubernetes are not part of the current verified execution path.

## Testing

The latest reported full test run passed **73 tests across 7 test files**.

The test suite includes DAG validation, workflow behavior, scheduler behavior, scheduler event recording, PostgreSQL storage, storage event-recorder integration, and MCP integration.

Run the following commands from the repository root to verify the current checkout:

```bash
npm run typecheck
npm test
```

Test counts describe the latest reported run and should be refreshed after subsequent changes.

## Change Log

- 2026-10-12: Initial TypeScript monorepo and MCP foundation established.
- 2026-10-13: DAG scheduling and initial PostgreSQL persistence work added.
- 2026-10-14: Added optional scheduler lifecycle event recording, PostgreSQL event-recorder integration, and scheduler/storage integration tests. Restart recovery and real-world tool execution remain pending.