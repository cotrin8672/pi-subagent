import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChild } from "./child.ts";
import { peekChild } from "./history.ts";
import { Manager, type Row } from "./manager.ts";

const stateEntry = "pig-subagent-state";
const text = Type.String({ minLength: 1 });
const result = <T>(details: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
});

export default function subagents(pi: ExtensionAPI) {
  // Per extension instance, not per process. Two Pig chats can share a PID.
  let owner: string | undefined;
  let manager: Manager | undefined;
  const history = new Map<string, Row>();

  function start(ctx: ExtensionContext) {
    const parentId = ctx.sessionManager.getSessionId();
    if (manager && owner === parentId) return manager;
    if (manager) throw Error("Subagent owner changed without shutdown");
    owner = parentId;
    history.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== stateEntry) continue;
      const saved = entry.data as Row & {
        parentSessionId?: string;
        version?: number;
      };
      if (
        saved?.version !== 1 ||
        saved.parentSessionId !== parentId ||
        !saved.agent_id
      )
        continue;
      history.set(
        saved.agent_id,
        saved.status === "starting" || saved.status === "running"
          ? { ...saved, status: "interrupted" }
          : saved,
      );
    }
    const local = new Manager(
      (row) => {
        if (manager !== local) return;
        history.set(row.agent_id, row);
        pi.appendEntry(stateEntry, {
          ...row,
          version: 1,
          parentSessionId: parentId,
        });
        pi.events.emit("pig:subagents:changed", { parentId });
      },
      (row) => {
        if (manager !== local) return;
        pi.sendMessage(
          {
            customType: "pig-subagent-completion",
            display: true,
            content: `${row.task_name}: ${row.status}\n${row.final_response ?? row.error ?? ""}`,
            details: { ...row, agent_name: row.task_name },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    );
    manager = local;
    return local;
  }

  pi.on("session_start", (_event, ctx) => {
    start(ctx);
  });
  pi.on("session_shutdown", async () => {
    const local = manager;
    manager = undefined;
    owner = undefined;
    history.clear();
    await local?.shutdown();
  });
  pi.events.on("pig:subagents:snapshot", (request: unknown) => {
    const req = request as {
      parentId?: string;
      reply?: (rows: Row[]) => void;
    } | null;
    if (manager && req?.parentId === owner && typeof req?.reply === "function")
      req.reply([...history.values()]);
  });
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description:
      "Delegate a self-contained read-only task in this workspace. Returns once accepted; completion arrives automatically. Continue independent work.",
    parameters: Type.Object({
      task_name: Type.String({ minLength: 1, maxLength: 100 }),
      message: text,
    }),
    async execute(_id, { task_name, message }, signal, _update, ctx) {
      return result(
        await start(ctx).spawn(
          task_name,
          message,
          () => createChild(ctx, pi, ctx.sessionManager.getSessionId()),
          signal,
        ),
      );
    },
  });
  pi.registerTool({
    name: "send_message",
    label: "Message agent",
    description:
      "Steer a running child or give a completed child another task in the same conversation.",
    parameters: Type.Object({ target: text, message: text }),
    async execute(_id, { target, message }, _signal, _update, ctx) {
      return result(await start(ctx).send(target, message));
    },
  });
  pi.registerTool({
    name: "wait_agent",
    label: "Wait for agent",
    description:
      "Wait for one outstanding result when blocked. Timeout or cancelling this wait does not stop any child.",
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(text)),
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      ),
    }),
    async execute(_id, { targets, timeout_ms }, signal, _update, ctx) {
      const local = start(ctx);
      const claim = await local.wait(targets, timeout_ms, signal);
      return result(
        claim ?? {
          received: false,
          agents: local
            .list()
            .filter(
              (r) =>
                !targets ||
                targets.includes(r.agent_id) ||
                targets.includes(r.task_name),
            )
            .map(({ agent_id, task_name, run_id, status }) => ({
              agent_id,
              task_name,
              run_id,
              status,
            })),
        },
      );
    },
  });
  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt agent",
    description: "Stop one child owned by this parent.",
    parameters: Type.Object({ target: text }),
    async execute(_id, { target }, _signal, _update, ctx) {
      return result(await start(ctx).interrupt(target));
    },
  });
  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description: "List this parent's children and their current states.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      start(ctx);
      return result(
        [...history.values()].map(
          ({ agent_id, task_name, run_id, status, final_response, error }) => ({
            agent_id,
            task_name,
            run_id,
            status,
            summary: (final_response ?? error)?.slice(0, 250),
          }),
        ),
      );
    },
  });
  pi.registerCommand("agents", {
    description: "Inspect this parent's subagent conversations (read only)",
    handler: async (_args, ctx) => {
      start(ctx);
      const rows = [...history.values()].reverse();
      if (!rows.length)
        return ctx.ui.notify("No subagents in this session.", "info");
      const labels = rows.map(
        (r) => `${r.task_name} — ${r.status} (${r.agent_id})`,
      );
      const choice = await ctx.ui.select("Subagents", labels);
      if (!choice) return;
      const row = rows[labels.indexOf(choice)];
      const file = ctx.sessionManager.getSessionFile();
      const transcript =
        file && row.child_session_id
          ? await peekChild(
              file,
              ctx.sessionManager.getSessionId(),
              row.child_session_id,
            )
          : undefined;
      await ctx.ui.editor(
        `${row.task_name} — read only`,
        transcript || row.final_response || row.error || row.status,
      );
    },
  });
}
