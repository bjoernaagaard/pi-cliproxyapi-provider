import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** Undefined when the file is missing. Throws, naming the file and field, when it breaks the schema. */
export const readJsonFile = <Schema extends TSchema>(
  filePath: string,
  schema: Schema
): Static<Schema> | undefined => {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    // SAFETY: Node filesystem errors carry the optional code field used to identify a missing file.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const value: unknown = JSON.parse(text);

  if (Value.Check(schema, value)) {
    return value;
  }

  const [first] = Value.Errors(schema, value);

  throw new Error(
    `Invalid ${path.basename(filePath)} at ${first?.instancePath || "/"}: ${first?.message ?? "unexpected shape"}`
  );
};

/** What identifies one version of a file. A rename gives a new inode, so atomic writes always differ. */
interface FileStamp {
  ino: number;
  mtimeMs: number;
  size: number;
}

interface MemoEntry {
  stamp: FileStamp;
  value: unknown;
}

/** Tells apart readers of one file: readJsonMemo's schema, or memoByFile's caller key. */
type MemoKey = TSchema | string;

/** Parsed values per file path, then per reader key. */
const memo = new Map<string, Map<MemoKey, MemoEntry>>();

const sameStamp = (left: FileStamp, right: FileStamp): boolean =>
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

const remember = <Value, Missing>(
  filePath: string,
  key: MemoKey,
  read: () => Value,
  missing: () => Missing
): Value | Missing => {
  const stats = statSync(filePath, { throwIfNoEntry: false });

  if (!stats) {
    memo.delete(filePath);

    return missing();
  }

  const stamp: FileStamp = {
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };

  const entries = memo.get(filePath) ?? new Map<MemoKey, MemoEntry>();
  const cached = entries.get(key);

  if (cached && sameStamp(cached.stamp, stamp)) {
    // SAFETY: Each key is stored only by the reader that owns it, so the value has that reader's type.
    return cached.value as Value;
  }

  const value = read();
  entries.set(key, { stamp, value });
  memo.set(filePath, entries);

  return value;
};

/**
 * Reads and validates a JSON file like readJsonFile, but reuses the last parse
 * while the file's inode, mtime and size are unchanged, so writes from other
 * pi processes are still seen. Callers share the returned object and must not
 * mutate it.
 */
export const readJsonMemo = <Schema extends TSchema>(
  filePath: string,
  schema: Schema
): Static<Schema> | undefined =>
  remember(
    filePath,
    schema,
    () => readJsonFile(filePath, schema),
    (): undefined => undefined
  );

/**
 * Memoizes any reader of one file by the same stamp. `key` separates readers
 * that pick different parts of the same file. A missing file is never cached,
 * so `read` then runs every call and decides what a missing file means.
 */
export const memoByFile = <Value>(
  filePath: string,
  read: () => Value,
  key = ""
): Value => remember(filePath, key, read, read);

/**
 * Writes pretty JSON to `<file>.<pid>.tmp`, then renames it over `file`, so
 * readers in other pi processes never see a half-written file. Serializes
 * first, so a value that cannot become JSON leaves the old file untouched.
 * The file is owner-only (0600) like pi's auth.json, because cliproxyapi.json
 * holds the API key and management key.
 */
const OWNER_ONLY = 0o600;

export const writeJsonAtomic = <Data>(filePath: string, value: Data): void => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(temporary, text, { encoding: "utf-8", mode: OWNER_ONLY });
  renameSync(temporary, filePath);
  memo.delete(filePath);
};
