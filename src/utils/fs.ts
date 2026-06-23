/**
 * Atomic filesystem write helpers.
 *
 * `fs.writeFile` truncates the target file then writes — a crash between
 * truncate and full write leaves a partial file. For YAML configs and
 * credential stores this means one Ctrl+C during a save can corrupt the
 * file and lock the user out of their own config.
 *
 * `atomicWriteFile` writes to a temp file then renames over the target.
 * POSIX rename(2) is atomic; on Windows, Bun's fs.rename handles the
 * overwrite case (Node has supported it since v10).
 */
import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Write `content` to `path` atomically: write to `{path}.{pid}.tmp` first,
 * then rename over `path`. If the process crashes mid-write, the temp file
 * is left behind (harmless) and the target file is unchanged.
 *
 * @param path Final destination path.
 * @param content File contents (string or Buffer).
 * @param encoding Text encoding when `content` is a string. Defaults to "utf-8".
 */
export async function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.tmp-${Date.now()}`);
  await writeFile(tmp, content, encoding);
  try {
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename failed (e.g. target
    // directory doesn't exist — but the writeFile above would have thrown
    // first, so this is purely defensive).
    try { await import("node:fs/promises").then(m => m.unlink(tmp)); } catch {}
    throw err;
  }
}

/**
 * Simple async mutex. Serializes concurrent callers so they execute in
 * FIFO order. Used to prevent two admin dashboard PUTs from racing on the
 * config file.
 *
 * Usage:
 *   const lock = createMutex();
 *   await lock.run(async () => { /* critical section *\/ });
 */
export interface AsyncMutex {
  /** Run `fn` while holding the lock. Other callers wait. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutex(): AsyncMutex {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(() => fn());
      // Swallow rejections on the stored chain so a failed task doesn't
      // poison every subsequent task. The returned `next` still surfaces
      // the rejection to the caller.
      chain = next.then(() => undefined, () => undefined);
      return next as Promise<T>;
    },
  };
}
