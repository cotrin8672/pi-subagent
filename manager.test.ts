import { expect, mock, test } from "bun:test";
import { type Child, Manager, type Row } from "./manager";

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const changed: Row[] = [],
    pushed: Row[] = [];
  return {
    m: new Manager(
      (row) => changed.push(row),
      (row) => pushed.push(row),
    ),
    changed,
    pushed,
  };
}
function child() {
  const turn = pending<string>();
  return {
    id: "session",
    turn,
    prompt: mock((_text: string) => turn.promise),
    steer: mock(async (_text: string) => {}),
    abort: mock(async () => {}),
    dispose: mock(async () => {}),
  };
}

test("slots and names are reserved before startup; parents are independent", async () => {
  const { m } = fixture(),
    other = fixture().m;
  const gate = pending<Child>();
  const a = m.spawn("a", "", () => gate.promise);
  await expect(m.spawn("a", "", async () => child())).rejects.toThrow(
    "duplicate",
  );
  await Promise.all(
    ["b", "c", "d"].map((name) => m.spawn(name, "", async () => child())),
  );
  await expect(m.spawn("x", "", async () => child())).rejects.toThrow(
    "capacity",
  );
  const foreign = await other.spawn("a", "", async () => child());
  await expect(m.interrupt(foreign.agent_id)).rejects.toThrow("unknown");
  await other.shutdown();
  expect(m.list().map((r) => r.status)).toEqual([
    "starting",
    "running",
    "running",
    "running",
  ]);
  gate.reject(new Error("init"));
  expect(await a).toMatchObject({ status: "failed", error: "init" });
  await m.spawn("a", "", async () => child());
  await m.shutdown();
});

test("interrupt during create releases reservation and cleans up a late child", async () => {
  const { m, pushed } = fixture(),
    gate = pending<Child>(),
    c = child();
  const started = m.spawn("a", "", () => gate.promise);
  await Promise.resolve();
  const interrupted = await m.interrupt("a");
  expect(await started).toEqual(interrupted);
  await m.spawn("a", "", async () => child());
  gate.resolve(c);
  await m.shutdown();
  expect(c.prompt).not.toHaveBeenCalled();
  expect(c.abort).toHaveBeenCalledTimes(1);
  expect(c.dispose).toHaveBeenCalledTimes(1);
  expect(pushed).toEqual([interrupted]);
});

test("one waiter claims a run; steer and followup use the same session", async () => {
  const { m, pushed } = fixture(),
    c = child();
  const row = await m.spawn("a", "start", async () => c);
  expect(await m.send(row.agent_id, "hint")).toEqual(row);
  expect(c.steer).toHaveBeenCalledWith("hint");
  const first = m.wait(),
    second = m.wait(["a"]);
  c.turn.resolve("answer");
  expect(await first).toMatchObject({
    run_id: row.run_id,
    final_response: "answer",
  });
  expect(await second).toBeUndefined();
  expect(await m.wait()).toBeUndefined();
  expect(pushed).toEqual([]);
  const next = pending<string>();
  c.prompt.mockImplementation(() => next.promise);
  const follow = await m.send("a", "more");
  expect(follow.run_id).not.toBe(row.run_id);
  expect(follow).toMatchObject({
    agent_id: row.agent_id,
    child_session_id: c.id,
    status: "running",
  });
  expect(follow.final_response).toBeUndefined();
  next.reject(new Error("provider"));
  await Promise.resolve();
  expect(pushed).toEqual([{ ...follow, status: "failed", error: "provider" }]);
  await expect(m.send("a", "retry")).rejects.toThrow("failed");
  await m.shutdown();
});

test("timeout and signal release only the waiter; interrupt wins over late settlement", async () => {
  const { m, pushed } = fixture(),
    c = child();
  await m.spawn("a", "", async () => c);
  const controller = new AbortController();
  const waiting = m.wait(undefined, undefined, controller.signal);
  controller.abort(new Error("cancel wait"));
  await expect(waiting).rejects.toThrow("cancel wait");
  await expect(m.wait(undefined, undefined, controller.signal)).rejects.toThrow(
    "cancel wait",
  );
  expect(await m.wait(["a"], 1)).toBeUndefined();
  expect(c.abort).not.toHaveBeenCalled();
  const stopped = m.interrupt("a");
  c.turn.resolve("late");
  expect(await stopped).toMatchObject({ status: "interrupted" });
  expect(pushed).toEqual([await m.interrupt("a")]);
  await m.shutdown();
  expect(c.dispose).toHaveBeenCalledTimes(1);
});

test("shutdown wakes waiters, closes admission and suppresses late callbacks", async () => {
  const { m, changed, pushed } = fixture(),
    c = child(),
    gate = pending<Child>(),
    late = child();
  await m.spawn("a", "", async () => c);
  const startup = m.spawn("b", "", () => gate.promise);
  await Promise.resolve();
  const waiting = m.wait(),
    count = changed.length;
  const closed = m.shutdown();
  expect(m.shutdown()).toBe(closed);
  expect(await waiting).toBeUndefined();
  expect((await startup).status).toBe("interrupted");
  await expect(m.spawn("x", "", async () => child())).rejects.toThrow(
    "shut down",
  );
  c.turn.reject(new Error("late"));
  gate.resolve(late);
  await closed;
  expect(late.prompt).not.toHaveBeenCalled();
  for (const handle of [late, c])
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  expect(changed).toHaveLength(count);
  expect(pushed).toEqual([]);
});

test("spawn signal cancels only startup, and skips creation if aborted before admission", async () => {
  const { m, pushed } = fixture();
  const controller = new AbortController();
  const gate = pending<Child>(),
    create = mock(() => gate.promise);
  const startup = m.spawn("a", "", create, controller.signal);
  await Promise.resolve();
  controller.abort(new Error("cancel startup"));
  expect(await startup).toMatchObject({ status: "interrupted" });
  await expect(m.spawn("b", "", create, controller.signal)).rejects.toThrow(
    "cancel startup",
  );
  expect(create).toHaveBeenCalledTimes(1);
  gate.reject(new Error("too late"));
  await m.shutdown();
  expect(pushed).toHaveLength(1);
});
