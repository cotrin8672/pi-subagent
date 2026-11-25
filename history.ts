import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// Only SDK-generated IDs may become path components; never accept a path from a tool.
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function childDirectory(parentFile: string, parentId: string) {
  if (!uuid.test(parentId)) throw Error("Invalid parent session ID");
  return resolve(dirname(parentFile), ".subagents", parentId);
}

export async function peekChild(
  parentFile: string,
  parentId: string,
  childId: string,
) {
  if (!uuid.test(childId)) throw Error("Invalid child session ID");
  const dir = childDirectory(parentFile, parentId);
  const name = (await readdir(dir, { withFileTypes: true })).find(
    (e) => e.isFile() && e.name.endsWith(`_${childId}.jsonl`),
  )?.name;
  if (!name) return;
  const path = await realpath(join(dir, name));
  const base = await realpath(dirname(parentFile));
  if (path !== join(base, ".subagents", parentId, basename(path)))
    throw Error("Invalid child session path");
  const file = await open(path, "r");
  try {
    // Show recent activity without slurping a long transcript into the host or dialog.
    const size = (await file.stat()).size;
    const offset = Math.max(0, size - 256 * 1024);
    const tail = Buffer.alloc(size - offset);
    const { bytesRead } = await file.read(tail, 0, tail.length, offset);
    const lines = tail.subarray(0, bytesRead).toString("utf8").split("\n");
    if (offset) lines.shift();
    return lines
      .flatMap((line) => {
        if (!line.trim()) return [];
        let entry: {
          type?: string;
          message?: { role?: string; toolName?: string; content?: unknown };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          return [];
        }
        const m = entry.type === "message" && entry.message;
        if (!m) return [];
        const body = Array.isArray(m.content)
          ? m.content
              .map(
                (p: {
                  type: string;
                  text?: string;
                  name?: string;
                  arguments?: unknown;
                }) =>
                  p.type === "text"
                    ? p.text
                    : p.type === "toolCall"
                      ? `${p.name} ${JSON.stringify(p.arguments)}`
                      : "",
              )
              .filter(Boolean)
              .join("\n")
          : m.content;
        return typeof body === "string" && body
          ? [`${m.toolName ?? m.role}: ${body}`]
          : [];
      })
      .join("\n\n");
  } finally {
    await file.close();
  }
}
