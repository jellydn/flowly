import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

/**
 * Trusted import of a candidate tree that an untrusted smolvm guest returns as
 * a tar archive. The archive is parsed in memory; no system `tar` extracts
 * untrusted metadata. Only regular files, directories, and symlinks that stay
 * inside the tree are accepted. `.git` paths, `..`, absolute paths, hard links,
 * devices, and entries below a symlink or file are refused.
 */

export type TreeEntry =
  | { path: string; type: 'file'; data: Buffer; executable: boolean }
  | { path: string; type: 'symlink'; target: string };

export type TreeArchiveLimits = { maxBytes: number; maxEntries: number };

export const DEFAULT_TREE_ARCHIVE_LIMITS: TreeArchiveLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
};

const BLOCK = 512;

export function parseTreeArchive(
  archive: Buffer,
  limits: TreeArchiveLimits = DEFAULT_TREE_ARCHIVE_LIMITS,
): TreeEntry[] {
  if (archive.length > limits.maxBytes) {
    throw new Error(
      `Candidate archive is ${archive.length} bytes; the limit is ${limits.maxBytes}.`,
    );
  }
  const entries = new Map<string, TreeEntry>();
  const directories = new Set<string>();
  let offset = 0;
  let count = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    assertChecksum(header);
    const size = octal(header, 124, 12, 'size');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error('Candidate archive is truncated.');
    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') longName = cString(data);
    else if (type === 'K') longLink = cString(data);
    else if (type === 'x') pax = parsePax(data);
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') continue;

    const name = cString(header.subarray(0, 100));
    const prefix =
      header.subarray(257, 262).toString('latin1') === 'ustar'
        ? cString(header.subarray(345, 500))
        : '';
    const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const rawLink = pax.linkpath ?? longLink ?? cString(header.subarray(157, 257));
    longName = longLink = undefined;
    pax = {};

    if (++count > limits.maxEntries) {
      throw new Error(`Candidate archive has more than ${limits.maxEntries} entries.`);
    }
    const entryPath = normalizeEntryPath(rawName);
    if (entryPath === undefined) continue;
    if (entries.has(entryPath) || (type !== '5' && directories.has(entryPath))) {
      throw new Error(`Candidate archive repeats the path "${entryPath}".`);
    }
    if (type === '5') {
      directories.add(entryPath);
    } else if (type === '2') {
      entries.set(entryPath, {
        path: entryPath,
        type: 'symlink',
        target: assertSymlinkTarget(entryPath, rawLink),
      });
    } else if (type === '0' || type === '7') {
      assertNotAppleDouble(entryPath, data);
      const mode = octal(header, 100, 8, 'mode');
      entries.set(entryPath, {
        path: entryPath,
        type: 'file',
        data: Buffer.from(data),
        executable: (mode & 0o111) !== 0,
      });
    } else {
      throw new Error(`Candidate archive entry "${entryPath}" has unsupported type "${type}".`);
    }
  }

  for (const entryPath of [...entries.keys(), ...directories]) {
    const parts = entryPath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join('/');
      if (entries.has(ancestor)) {
        throw new Error(`Candidate path "${entryPath}" is below the non-directory "${ancestor}".`);
      }
    }
  }
  return [...entries.values()];
}

/**
 * Paths an implementation candidate may never add, change, or delete: CI and
 * workflow definitions, Flowly/Flue review and agent configuration, and Git
 * attribute/submodule files that change how trusted Git reads the tree.
 * Compared case-insensitively, because macOS file systems ignore case.
 */
export const PROTECTED_PATH_PREFIXES = ['.github/', '.flowly/', '.flue/', '.agents/'] as const;
export const PROTECTED_FILES = ['.gitmodules', '.gitattributes'] as const;

export function isProtectedPath(entryPath: string): boolean {
  const lower = entryPath.toLowerCase();
  return (
    (PROTECTED_FILES as readonly string[]).includes(lower) ||
    PROTECTED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix) || `${lower}/` === prefix)
  );
}

/**
 * Make the working tree at `root` equal to `entries`, ignoring the top-level
 * `.git` directory. Every change is planned first and the whole import is
 * refused, before any write, when it touches a protected path or adds or
 * changes a symlink (unchanged symlinks of the base tree are kept). Writes
 * never follow a symlink, and every parent directory is checked to resolve
 * inside the root. Returns the changed paths.
 */
export async function importTree(
  root: string,
  entries: TreeEntry[],
  options: { isProtected?: (entryPath: string) => boolean } = {},
): Promise<string[]> {
  const isProtected = options.isProtected ?? isProtectedPath;
  const realRoot = await realpath(root);
  const desired = new Set(entries.map((entry) => entry.path));
  const deletions: string[] = [];
  for (const [entryPath, kind] of await listTree(realRoot)) {
    if (kind !== 'directory' && !desired.has(entryPath)) deletions.push(entryPath);
  }
  const writes: TreeEntry[] = [];
  for (const entry of entries) {
    if (!(await matches(hostPath(realRoot, entry.path), entry))) writes.push(entry);
  }

  for (const entryPath of [...deletions, ...writes.map((entry) => entry.path)]) {
    if (isProtected(entryPath)) {
      throw new Error(`Candidate changes the protected path "${entryPath}".`);
    }
  }
  const symlinkWrite = writes.find((entry) => entry.type === 'symlink');
  if (symlinkWrite) {
    throw new Error(`Candidate adds or changes the symlink "${symlinkWrite.path}".`);
  }

  for (const entryPath of deletions) await rm(hostPath(realRoot, entryPath), { force: true });
  for (const entry of writes) {
    if (entry.type !== 'file') continue;
    const target = hostPath(realRoot, entry.path);
    await ensureDirectory(realRoot, path.dirname(target));
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !existing.isFile()) await rm(target, { recursive: true, force: true });
    const mode = entry.executable ? 0o755 : 0o644;
    await writeFile(target, entry.data, { mode });
    await chmod(target, mode);
  }
  return [...deletions, ...writes.map((entry) => entry.path)].sort();
}

/** True when the host path already holds exactly this entry. Never follows a symlink. */
async function matches(target: string, entry: TreeEntry): Promise<boolean> {
  const existing = await lstat(target).catch(() => undefined);
  if (!existing) return false;
  if (entry.type === 'symlink') {
    return existing.isSymbolicLink() && (await readlink(target)) === entry.target;
  }
  return (
    existing.isFile() &&
    ((existing.mode & 0o111) !== 0) === entry.executable &&
    (await readFile(target)).equals(entry.data)
  );
}

/** Magic number that starts every AppleDouble (`._name`) resource-fork file. */
const APPLE_DOUBLE_MAGIC = 0x00051607;

/**
 * The candidate archive always comes from `tar` in the Linux guest, which never
 * writes AppleDouble files. One here means a macOS tool packed the tree or the
 * guest planted macOS metadata, so the import fails closed. An ordinary file
 * whose name starts with `._` is still accepted.
 */
function assertNotAppleDouble(entryPath: string, data: Buffer): void {
  const name = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  if (name.startsWith('._') && data.length >= 4 && data.readUInt32BE(0) === APPLE_DOUBLE_MAGIC) {
    throw new Error(`Candidate archive has the macOS AppleDouble entry "${entryPath}".`);
  }
}

function normalizeEntryPath(raw: string): string | undefined {
  if (raw.startsWith('/')) throw new Error(`Candidate archive has the absolute path "${raw}".`);
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (part === '..') throw new Error(`Candidate archive path "${raw}" leaves the tree.`);
    // Case-insensitive: macOS file systems treat `.GIT` as `.git`.
    if (part.toLowerCase() === '.git') {
      throw new Error(`Candidate archive path "${raw}" touches Git metadata.`);
    }
  }
  return parts.join('/');
}

function assertSymlinkTarget(entryPath: string, target: string): string {
  if (!target || target.startsWith('/')) {
    throw new Error(`Candidate symlink "${entryPath}" must have a relative target.`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`Candidate symlink "${entryPath}" points outside the tree.`);
  }
  if (resolved.split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new Error(`Candidate symlink "${entryPath}" points into Git metadata.`);
  }
  return target;
}

async function listTree(root: string): Promise<Map<string, 'file' | 'symlink' | 'directory'>> {
  const result = new Map<string, 'file' | 'symlink' | 'directory'>();
  const walk = async (relative: string): Promise<void> => {
    for (const name of await readdir(path.join(root, relative))) {
      if (!relative && name === '.git') continue;
      const child = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(root, child));
      if (stat.isDirectory()) {
        result.set(child, 'directory');
        await walk(child);
      } else {
        result.set(child, stat.isSymbolicLink() ? 'symlink' : 'file');
      }
    }
  };
  await walk('');
  return result;
}

/** Create each missing directory below root; replace a file or symlink in the way. */
async function ensureDirectory(root: string, directory: string): Promise<void> {
  const parts = path.relative(root, directory).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (stat?.isDirectory()) continue;
    if (stat) await rm(current, { force: true });
    await mkdir(current);
  }
  const resolved = await realpath(directory);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside the workspace: ${resolved}`);
  }
}

function hostPath(root: string, entryPath: string): string {
  return path.join(root, ...entryPath.split('/'));
}

function assertChecksum(header: Buffer): void {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (sum !== octal(header, 148, 8, 'checksum')) {
    throw new Error('Candidate archive has a header with a wrong checksum.');
  }
}

function octal(header: Buffer, start: number, length: number, field: string): number {
  if (header[start] & 0x80)
    throw new Error(`Candidate archive uses an unsupported ${field} encoding.`);
  const text = header
    .subarray(start, start + length)
    .toString('latin1')
    .replace(/[\0 ]+/g, ' ')
    .trim();
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || !/^[0-7]*$/.test(text)) {
    throw new Error(`Candidate archive has an invalid ${field} field.`);
  }
  return value;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (space === -1 || !Number.isInteger(length) || length <= 0) {
      throw new Error('Candidate archive has an invalid pax header.');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}
