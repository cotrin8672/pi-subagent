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

test.each([
  "idle",
  "busy",
])("subagent results stay unread when the parent is %s", async (parentState) => {
  const root = await mkdtemp(join(tmpdir(), "pig-subagent-sdk-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "profile");
  const provider = "fixture-selected-account";
  const apiKey = "session-only-key";
  const parentPrompt = "PARENT-ONLY: delegate the fixture check";
  const statusPrompt = "Check agent status only";
  const pollPrompt = "Poll for a result";
  const task = "Check the two fixture files";
  const publicData = "permitted fixture bytes";
  const privateData = "restricted fixture bytes";
  const answer = "Verified read and denial";
  const gate = Promise.withResolvers<void>();
  const parentStarted = Promise.withResolvers<void>();
  const parentGate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const requests: { key?: string; provider: string }[] = [];
  const childInputs: string[] = [];
  const advertised: string[] = [];
  let spawnDescription: string | undefined;
  let session: AgentSession | undefined;
  async function closeParent() {
    if (!session) return;
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
    session = undefined;
  }
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
      if (last?.role === "toolResult" && last.toolName === "spawn_agent") {
        if (parentState === "busy") {
          parentStarted.resolve();
          await parentGate.promise;
        }
        return fauxAssistantMessage("Independent parent work finished");
      }
      if (JSON.stringify(last).includes(parentPrompt)) {
        spawnDescription = ctx.messages
          .flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []))
          .find((t) => t.name === "spawn_agent")?.description;
        return call("spawn_agent", { task_name: "reader", message: task });
      }
      if (JSON.stringify(last).includes(statusPrompt))
        return call("list_agents", {});
      if (last?.role === "toolResult" && last.toolName === "list_agents")
        return fauxAssistantMessage("Checked status");
      if (JSON.stringify(last).includes(pollPrompt))
        return call("wait_agent", { targets: ["reader"], timeout_ms: 0 });
      if (last?.role === "toolResult" && last.toolName === "wait_agent")
        return fauxAssistantMessage("Checked the wait result");
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
          return fauxAssistantMessage(answer);
      }
      throw Error(`Unexpected provider input: ${JSON.stringify(last)}`);
    };
    faux.setResponses(Array.from({ length: 11 }, () => respond));
    const sessionManager = SessionManager.create(
      cwd,
      join(agentDir, "sessions"),
    );
    async function openParent(manager: SessionManager) {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: faux.getModel(),
        tools: ["read", ...toolNames],
        resourceLoader: loader,
        settingsManager,
        sessionManager: manager,
      });
      await session.bindExtensions({});
      return session;
    }
    const parent = await openParent(sessionManager);
    session = parent;
    for (const name of toolNames)
      expect(parent.getActiveToolNames()).toContain(name);
    parent.subscribe((event) => {
      if (
        event.type === "entry_appended" &&
        event.entry.type === "custom" &&
        event.entry.customType === "pig-subagent-state" &&
        (event.entry.data as { status: string }).status === "completed"
      )
        completed.resolve();
    });
    const prompting = parent.prompt(parentPrompt);
    await (parentState === "busy" ? parentStarted.promise : prompting);
    gate.resolve();
    await completed.promise;
    parentGate.resolve();
    await prompting;
    await parent.waitForIdle();
    expect(spawnDescription).toContain(
      "at most 4 subagents starting or running",
    );
    expect(requests).toHaveLength(5);
    expect(JSON.stringify(parent.messages)).not.toContain(answer);
    expect(parent.messages.some((m) => m.role === "custom")).toBe(false);
    const spawn = parent.messages.find(
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
    const ref = { ...ids, status: "completed" };
    // Even the next ordinary prompt and status lookup must not see the answer.
    await parent.prompt(statusPrompt);
    expect(
      parent.messages.find(
        (m) => m.role === "toolResult" && m.toolName === "list_agents",
      ),
    ).toMatchObject({
      isError: false,
      details: [{ ...ref, task_name: "reader" }],
    });
    expect(JSON.stringify(parent.messages)).not.toContain(answer);
    const file = sessionManager.getSessionFile();
    if (!file) throw Error("Expected persistent parent session");
    await closeParent();
    session = await openParent(SessionManager.open(file));
    await session.prompt(pollPrompt);
    expect(
      session.messages.find(
        (m) => m.role === "toolResult" && m.toolName === "wait_agent",
      ),
    ).toMatchObject({
      isError: false,
      details: { ...ref, final_response: answer },
    });
    await closeParent();
    session = await openParent(SessionManager.open(file));
    await session.prompt(pollPrompt);
    const waits = session.messages.filter(
      (m) => m.role === "toolResult" && m.toolName === "wait_agent",
    );
    expect(waits).toHaveLength(2);
    expect(waits[1]).toMatchObject({
      isError: false,
      details: { received: false },
    });
    expect(denied).toEqual(["private.txt"]);
    expect(childInputs).toHaveLength(3);
    expect(advertised).toEqual(["read"]);
    expect(childInputs.join("\n")).not.toContain(parentPrompt);
    expect(childInputs.join("\n")).not.toContain(privateData);
    expect(requests).toEqual(Array(11).fill({ key: apiKey, provider }));
    expect(
      session.messages.filter(
        (m) => m.role === "toolResult" && m.toolName === "read",
      ),
    ).toHaveLength(0);
    await closeParent();
    expect(modelRuntime.getRegisteredNativeProvider(provider)).toBeDefined();
    const entries = SessionManager.open(file).getBranch();
    const completions = entries.filter(
      (e) =>
        e.type === "custom_message" &&
        e.customType === "pig-subagent-completion",
    );
    expect(completions).toHaveLength(0);
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
    for (const text of [task, publicData, "fixture read denied", answer])
      expect(transcript).toContain(text);
    for (const text of [privateData, parentPrompt, apiKey])
      expect(transcript).not.toContain(text);
    expect(await readFile(file, "utf8")).not.toContain(apiKey);
  } finally {
    gate.resolve();
    parentGate.resolve();
    await closeParent();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
