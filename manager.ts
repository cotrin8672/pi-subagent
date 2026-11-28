import { randomUUID } from "node:crypto";

export interface Child {
  id: string;
  prompt(text: string): Promise<string>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface Row {
  agent_id: string;
  task_name: string;
  child_session_id?: string;
  run_id: string;
  status: "starting" | "running" | "completed" | "failed" | "interrupted";
  final_response?: string;
  error?: string;
}

interface Entry {
  row: Row;
  child?: Child;
  started?: (row: Row) => void;
  startup?: Promise<void>;
  cleanup?: Promise<void>;
}
type Waiter = { runs: Set<string>; finish(row?: Row): void };
const active = (row: Row) =>
  row.status === "starting" || row.status === "running";
export const matchesTarget = (row: Row, targets?: readonly string[]) =>
  !targets || targets.includes(row.agent_id) || targets.includes(row.task_name);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class Manager {
  private readonly agents = new Map<string, Entry>();
  private readonly names = new Map<string, Entry>();
  private readonly waiters = new Set<Waiter>();
  private closing?: Promise<void>;

  constructor(
    private readonly onChange: (row: Row) => void,
    private readonly unread = new Map<string, Row>(),
  ) {}

  list(): Row[] {
    return Array.from(this.agents.values(), ({ row }) => ({ ...row }));
  }

  private lookup(target: string): Entry {
    if (this.closing) throw new Error("manager shut down");
    const entry = this.agents.get(target) ?? this.names.get(target);
    if (!entry) throw new Error(`unknown target: ${target}`);
    return entry;
  }

  private checkCapacity() {
    if (this.closing) throw new Error("manager shut down");
    if ([...this.agents.values()].filter((e) => active(e.row)).length >= 4)
      throw new Error("capacity");
  }

  // Replacing (rather than mutating) rows makes row identity a run/phase guard.
  private terminal(
    entry: Entry,
    prior: Row,
    result: Pick<Row, "status" | "final_response" | "error">,
  ) {
    if (entry.row !== prior || !active(prior)) return;
    const row = { ...prior, ...result };
    entry.row = row;
    entry.started?.({ ...row });
    if (this.closing) return;
    let claimed = false;
    for (const waiter of this.waiters) {
      if (!waiter.runs.delete(row.run_id)) continue;
      if (!claimed) {
        waiter.finish({ ...row });
        claimed = true;
      } else if (!waiter.runs.size) waiter.finish();
    }
    if (!claimed) this.unread.set(row.run_id, row);
    this.onChange({ ...row });
  }

  private launch(entry: Entry, child: Child, message: string): Row {
    const row: Row = {
      ...entry.row,
      child_session_id: child.id,
      status: "running",
    };
    entry.row = row;
    this.onChange({ ...row });
    if (!this.closing && entry.row === row) {
      void (async () => {
        let text: string;
        try {
          text = await child.prompt(message);
        } catch (error) {
          this.terminal(entry, row, {
            status: "failed",
            error: errorText(error),
          });
          return;
        }
        this.terminal(entry, row, {
          status: "completed",
          final_response: text,
        });
      })();
    }
    return { ...entry.row };
  }

  async spawn(
    name: string,
    message: string,
    create: () => Promise<Child>,
    signal?: AbortSignal,
  ): Promise<Row> {
    signal?.throwIfAborted();
    this.checkCapacity();
    const old = this.names.get(name);
    if (
      !name.trim() ||
      this.agents.has(name) ||
      (old && old.row.status !== "interrupted" && old.row.status !== "failed")
    )
      throw new Error("invalid or duplicate task name");
    const row: Row = {
      agent_id: randomUUID(),
      task_name: name,
      run_id: randomUUID(),
      status: "starting",
    };
    const entry: Entry = { row };
    this.agents.set(row.agent_id, entry);
    this.names.set(name, entry);
    const abortStartup = () =>
      this.terminal(entry, row, { status: "interrupted" });
    signal?.addEventListener("abort", abortStartup, { once: true });
    let rejectStartup!: (error: unknown) => void;
    const started = new Promise<Row>((resolve, reject) => {
      entry.started = resolve;
      rejectStartup = reject;
    });
    entry.startup = Promise.resolve().then(async () => {
      if (entry.row !== row || this.closing) return;
      let child: Child;
      try {
        child = await create();
      } catch (error) {
        this.terminal(entry, row, {
          status: "failed",
          error: errorText(error),
        });
        return;
      }
      entry.child = child;
      if (entry.row !== row || this.closing) await this.release(entry, true);
      else entry.started?.(this.launch(entry, child, message));
    });
    // Observe late cleanup failures even if interruption already settled spawn.
    // shutdown also awaits startup and reports those failures to its caller.
    void entry.startup.catch(rejectStartup);
    this.onChange({ ...row });
    try {
      return await started;
    } finally {
      signal?.removeEventListener("abort", abortStartup);
      delete entry.started;
    }
  }

  async send(target: string, message: string): Promise<Row> {
    const entry = this.lookup(target);
    const { row, child } = entry;
    if (row.status === "running" && child) {
      await child.steer(message);
      return { ...row };
    }
    if (row.status !== "completed" || !child)
      throw new Error(`cannot send while ${row.status}`);
    this.checkCapacity();
    entry.row = {
      agent_id: row.agent_id,
      task_name: row.task_name,
      status: "running",
      run_id: randomUUID(),
    };
    return this.launch(entry, child, message);
  }

  private release(entry: Entry, abort: boolean): Promise<void> {
    const child = entry.child;
    if (!child) return Promise.resolve();
    entry.cleanup ??= Promise.resolve().then(async () => {
      try {
        if (abort) await child.abort();
      } finally {
        await child.dispose();
        delete entry.child;
      }
    });
    return entry.cleanup;
  }

  async interrupt(target: string): Promise<Row> {
    const entry = this.lookup(target);
    const prior = entry.row;
    if (active(prior)) {
      const cleanup = this.release(entry, true);
      this.terminal(entry, prior, { status: "interrupted" });
      await cleanup;
    }
    return { ...entry.row };
  }

  async wait(
    targets?: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Row | undefined> {
    signal?.throwIfAborted();
    if (this.closing) return;
    for (const [id, row] of this.unread) {
      if (!matchesTarget(row, targets)) continue;
      this.unread.delete(id);
      return { ...row };
    }
    const runs = new Set(
      [...this.agents.values()]
        .filter(({ row }) => active(row) && matchesTarget(row, targets))
        .map(({ row }) => row.run_id),
    );
    if (!runs.size || (timeoutMs !== undefined && timeoutMs <= 0)) return;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        this.waiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        runs,
        finish(row) {
          cleanup();
          resolve(row);
        },
      };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => waiter.finish(), timeoutMs);
    });
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    // Close admission and delivery synchronously, including during observer re-entry.
    const cleanups: Promise<void>[] = [];
    this.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(cleanups);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    });
    for (const waiter of this.waiters) waiter.finish();
    for (const entry of this.agents.values()) {
      const running = active(entry.row);
      if (running) this.terminal(entry, entry.row, { status: "interrupted" });
      cleanups.push(this.release(entry, running));
      if (entry.startup) cleanups.push(entry.startup);
    }
    return this.closing;
  }
}
