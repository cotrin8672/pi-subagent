import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionToolContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { childDirectory } from "./history.ts";
import type { Child } from "./manager.ts";
export type { Child } from "./manager.ts";

async function privateDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(path)).isDirectory())
    throw new Error(`Not a session directory: ${path}`);
}

const readonlyNames = new Set(["read", "grep", "find", "ls"]);

export async function createChild(
  ctx: ExtensionToolContext,
  pi: ExtensionAPI,
  parentId: string,
): Promise<Child> {
  if (parentId !== ctx.sessionManager.getSessionId())
    throw new Error("Parent session mismatch");
  const { model, modelRegistry, cwd } = ctx;
  if (!model || typeof modelRegistry?.streamSimple !== "function")
    throw new Error("Parent model runtime unavailable");
  const thinkingLevel = pi.getThinkingLevel();
  const active = new Set(pi.getActiveTools());
  const tools: AgentTool[] = ctx.tools
    .filter((t) => active.has(t.name) && readonlyNames.has(t.name))
    .map(({ name, label, parameters, description }) => ({
      name,
      label,
      parameters,
      description,
      async execute(_id, args, signal, onUpdate) {
        if (!pi.getActiveTools().includes(name))
          throw new Error(`Inactive parent tool: ${name}`);
        const { result, isError } = await ctx.executeTool(name, args, {
          signal,
          onUpdate,
        });
        return { ...result, isError };
      },
    }));

  const parentFile = ctx.sessionManager.getSessionFile();
  let session: SessionManager;
  if (parentFile) {
    const directory = childDirectory(parentFile, parentId);
    await privateDirectory(dirname(directory));
    await privateDirectory(directory);
    session = SessionManager.create(cwd, directory);
  } else {
    session = SessionManager.inMemory(cwd);
  }
  const id = session.getSessionId();
  const agent = new Agent({
    sessionId: id,
    initialState: {
      model,
      thinkingLevel,
      tools,
      systemPrompt:
        "You are a read-only subagent. Answer the delegated task using the available tools.",
    },
    // The parent owns registration, account selection and request-time auth. Never clone/reset its runtime.
    streamFn: (m, context, options) =>
      modelRegistry.streamSimple(m, context, options),
  });
  session.appendModelChange(model.provider, model.id);
  session.appendThinkingLevelChange(thinkingLevel);
  const system = agent.state.messages[0];
  if (system?.role === "system") session.appendMessage(system);
  const unsubscribe = agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    const m = event.message;
    if (
      m.role === "assistant" ||
      m.role === "user" ||
      m.role === "toolResult" ||
      m.role === "system"
    )
      session.appendMessage(m);
  });
  let disposal: Promise<void> | undefined;
  async function abort() {
    agent.clearAllQueues();
    agent.abort();
    await agent.waitForIdle();
  }
  return {
    id,
    async prompt(text) {
      if (disposal) throw new Error("Child disposed");
      await agent.prompt(text);
      const message = agent.state.messages.at(-1);
      if (message?.role !== "assistant")
        throw new Error("No final assistant message");
      if (message.stopReason !== "stop" && message.stopReason !== "length")
        throw new Error(message.errorMessage || message.stopReason);
      return message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    },
    async steer(text) {
      if (disposal || !agent.signal || agent.signal.aborted)
        throw new Error("Child is not running");
      agent.steer({ role: "user", content: text, timestamp: Date.now() });
    },
    abort,
    dispose() {
      disposal ??= abort().then(() => {
        unsubscribe();
        cleanupSessionResources(id);
      });
      return disposal;
    },
  };
}
