import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionToolContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createChild } from "./child.ts";
import { childDirectory } from "./history.ts";

async function fixture(dir: string, persistent: boolean) {
  const sessionManager = persistent
    ? SessionManager.create(dir, dir)
    : SessionManager.inMemory(dir);
  const faux = fauxProvider({
    provider: "parent-only",
    models: [{ id: "selected", reasoning: true }],
    tokensPerSecond: Infinity,
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Selected account",
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key },
        }),
      },
    },
  });
  await runtime.setRuntimeApiKey("parent-only", "account-secret");
  const calls: string[] = [];
  const ctx = {
    cwd: dir,
    sessionManager,
    modelRegistry: registry,
    model: faux.getModel(),
    tools: ["read", "grep", "bash", "spawn_agent"].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute() {
        throw Error("raw tool bypass");
      },
    })),
    async executeTool(
      name: string,
      args: { path: string },
      options: { signal: AbortSignal },
    ) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      calls.push(`${name}:${args.path}`);
      return {
        result: {
          content: [{ type: "text", text: "blocked by parent" }],
          details: {},
        },
        isError: true,
      };
    },
  } as unknown as ExtensionToolContext;
  const pi = {
    getActiveTools: () => ["read", "bash", "spawn_agent"],
    getThinkingLevel: () => "low",
  } as ExtensionAPI;
  const child = await createChild(ctx, pi, sessionManager.getSessionId());
  return { child, faux, calls, parent: sessionManager, registry };
}

test("parent-only registration and auth, nested permission denial and standard isolated history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-"));
  try {
    const { child, faux, calls, parent, registry } = await fixture(dir, true);
    faux.setResponses([
      (context, options, _state, model) => {
        expect([
          model.provider,
          model.id,
          options?.apiKey,
          options?.reasoning,
          options?.sessionId,
        ]).toEqual([
          "parent-only",
          "selected",
          "account-secret",
          "low",
          child.id,
        ]);
        const system = context.messages[0];
        expect(
          system.role === "system" && system.toolsAdded?.map((t) => t.name),
        ).toEqual(["read"]);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "restricted" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expect(context.messages.at(-1)).toMatchObject({
          role: "toolResult",
          isError: true,
          content: [{ type: "text", text: "blocked by parent" }],
        });
        return fauxAssistantMessage("denied");
      },
      fauxAssistantMessage("another turn"),
    ]);
    try {
      expect(await child.prompt("inspect")).toBe("denied");
      expect(calls).toEqual(["read:restricted"]);
      expect(await child.prompt("continue")).toBe("another turn");
    } finally {
      await child.dispose();
    }
    expect(registry.getProvider("parent-only")).toBeDefined();
    const childDir = childDirectory(
      parent.getSessionFile()!,
      parent.getSessionId(),
    );
    const files = await readdir(childDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(`_${child.id}.jsonl`)).toBe(true);
    const path = join(childDir, files[0]);
    expect(await readFile(path, "utf8")).not.toContain("account-secret");
    const restored = SessionManager.open(path);
    expect(restored.getSessionId()).toBe(child.id);
    expect(
      restored
        .getEntries()
        .flatMap((e) => (e.type === "message" ? [e.message.role] : [])),
    ).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(parent.getEntries()).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ephemeral child steers, surfaces provider failure, and aborts an active request on disposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-"));
  try {
    const { child, faux } = await fixture(dir, false);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const awaitingAbort = Promise.withResolvers<void>();
    faux.setResponses([
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("first");
      },
      (context) => {
        expect(context.messages.at(-1)).toMatchObject({
          role: "user",
          content: "correction",
        });
        return fauxAssistantMessage("steered");
      },
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider failed",
      }),
      async (_c, opts) => {
        awaitingAbort.resolve();
        await new Promise<void>((r) =>
          opts!.signal!.addEventListener("abort", () => r(), { once: true }),
        );
        return fauxAssistantMessage("late");
      },
    ]);
    await expect(child.steer("too early")).rejects.toThrow();
    const first = child.prompt("start");
    await entered.promise;
    await child.steer("correction");
    release.resolve();
    expect(await first).toBe("steered");
    await expect(child.prompt("fails")).rejects.toThrow("provider failed");
    const pending = child.prompt("stop me").catch((err: Error) => err);
    await awaitingAbort.promise;
    await Promise.all([child.dispose(), child.dispose()]);
    expect(await pending).toBeInstanceOf(Error);
    await expect(child.prompt("closed")).rejects.toThrow("disposed");
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
