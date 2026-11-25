import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { peekChild } from "./history.ts";

const toolNames = [
  "spawn_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
];
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("installed extension delegates reads through parent policy and resumes the idle parent exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pig-subagent-sdk-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "profile");
  const provider = "fixture-selected-account";
  const apiKey = "session-only-key";
  const parentPrompt = "PARENT-ONLY: delegate the fixture check";
  const task = "Check the two fixture files";
  const publicData = "permitted fixture bytes";
  const privateData = "restricted fixture bytes";
  const gate = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const requests: { key?: string; provider: string }[] = [];
  const childInputs: string[] = [];
  const advertised: string[] = [];
  let session: AgentSession | undefined;
  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    await writeFile(join(cwd, "public.txt"), publicData);
    await writeFile(join(cwd, "private.txt"), privateData);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
    });
    const denied: string[] = [];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths: [import.meta.dir],
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (
              event.toolName === "read" &&
              event.input.path === "private.txt"
            ) {
              denied.push(event.input.path);
              return { block: true, reason: "fixture read denied" };
            }
          });
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const faux = fauxProvider({ provider, tokensPerSecond: Infinity });
    const selectedAuth = join(root, "selected-account.json");
    for (const [path, key] of [
      [join(agentDir, "auth.json"), "default-key"],
      [selectedAuth, apiKey],
    ] as const) {
      await writeFile(
        path,
        JSON.stringify({ [provider]: { type: "api_key", key } }),
      );
    }
    const modelRuntime = await ModelRuntime.create({
      authPath: selectedAuth,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Fixture",
          resolve: async ({ credential }) =>
            credential && { auth: { apiKey: credential.key } },
        },
      },
    });
    // Route by actual transcript, not a race-sensitive order of parent/child requests.
    const respond: FauxResponseFactory = async (ctx, opts, _state, model) => {
      requests.push({ key: opts?.apiKey, provider: model.provider });
      const last = ctx.messages.at(-1);
      if (last?.role === "toolResult" && last.toolName === "spawn_agent")
        return fauxAssistantMessage("Independent parent work finished");
      if (JSON.stringify(last).includes(parentPrompt))
        return call("spawn_agent", { task_name: "reader", message: task });
      if (last?.role === "user" && JSON.stringify(last).includes(task)) {
        childInputs.push(JSON.stringify(ctx));
        for (const message of ctx.messages) {
          if (message.role === "system")
            advertised.push(...(message.toolsAdded ?? []).map((t) => t.name));
        }
        await gate.promise;
        return call("read", { path: "public.txt" });
      }
      if (last?.role === "toolResult" && last.toolName === "read") {
        childInputs.push(JSON.stringify(ctx));
        if (JSON.stringify(last).includes(publicData))
          return call("read", { path: "private.txt" });
        if (
          last.isError &&
          JSON.stringify(last).includes("fixture read denied")
        )
          return fauxAssistantMessage("Verified read and denial");
      }
      if (JSON.stringify(last).includes("Verified read and denial")) {
        resumed.resolve();
        return fauxAssistantMessage("Completion acknowledged");
      }
      throw Error(`Unexpected provider input: ${JSON.stringify(last)}`);
    };
    faux.setResponses(Array.from({ length: 6 }, () => respond));
    const sessionManager = SessionManager.create(
      cwd,
      join(agentDir, "sessions"),
    );
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      tools: ["read", ...toolNames],
      resourceLoader: loader,
      settingsManager,
      sessionManager,
    }));
    await session.bindExtensions({});
    for (const name of toolNames)
      expect(session.getActiveToolNames()).toContain(name);
    await session.prompt(parentPrompt);
    const spawn = session.messages.find(
      (m) => m.role === "toolResult" && m.toolName === "spawn_agent",
    );
    expect(spawn).toMatchObject({
      isError: false,
      details: { task_name: "reader", status: "running" },
    });
    if (spawn?.role !== "toolResult") throw Error("Missing spawn result");
    const ids = spawn.details as {
      agent_id: string;
      run_id: string;
      child_session_id: string;
    };
    expect(session.messages.some((m) => m.role === "custom")).toBe(false);
    gate.resolve();
    await Promise.race([
      resumed.promise,
      new Promise<void>((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              Error(
                `Parent did not resume: ${JSON.stringify(session?.messages.slice(-2))}`,
              ),
            ),
          5000,
        );
        timer.unref();
        resumed.promise.then(() => clearTimeout(timer));
      }),
    ]);
    await session.waitForIdle();
    expect(denied).toEqual(["private.txt"]);
    expect(childInputs).toHaveLength(3);
    expect(advertised).toEqual(["read"]);
    expect(childInputs.join("\n")).not.toContain(parentPrompt);
    expect(childInputs.join("\n")).not.toContain(privateData);
    expect(requests).toEqual(Array(6).fill({ key: apiKey, provider }));
    expect(
      session.messages.filter(
        (m) => m.role === "toolResult" && m.toolName === "read",
      ),
    ).toHaveLength(0);
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
    session = undefined;
    expect(modelRuntime.getRegisteredNativeProvider(provider)).toBeDefined();
    const file = sessionManager.getSessionFile();
    if (!file) throw Error("Expected persistent parent session");
    const entries = SessionManager.open(file).getBranch();
    const completions = entries.filter(
      (e) =>
        e.type === "custom_message" &&
        e.customType === "pig-subagent-completion",
    );
    expect(completions).toHaveLength(1);
    const ref = {
      agent_id: ids.agent_id,
      run_id: ids.run_id,
      child_session_id: ids.child_session_id,
      status: "completed",
    };
    expect(completions[0]).toMatchObject({ details: ref });
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "pig-subagent-state",
        data: expect.objectContaining({
          ...ref,
          parentSessionId: sessionManager.getSessionId(),
          version: 1,
        }),
      }),
    );
    const transcript = await peekChild(
      file,
      sessionManager.getSessionId(),
      ids.child_session_id,
    );
    for (const text of [
      task,
      publicData,
      "fixture read denied",
      "Verified read and denial",
    ])
      expect(transcript).toContain(text);
    for (const text of [privateData, parentPrompt, apiKey])
      expect(transcript).not.toContain(text);
    expect(await readFile(file, "utf8")).not.toContain(apiKey);
  } finally {
    gate.resolve();
    if (session) {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
