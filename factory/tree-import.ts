import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
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
 * Make the working tree at `root` equal to `entries`, ignoring the top-level
 * `.git` directory. Writes never follow a symlink, and every parent directory
 * is checked to resolve inside the root. Returns the changed paths.
 */
export async function importTree(root: string, entries: TreeEntry[]): Promise<string[]> {
  const realRoot = await realpath(root);
  const desired = new Map(entries.map((entry) => [entry.path, entry]));
  const changed = new Set<string>();

  for (const [entryPath, kind] of await listTree(realRoot)) {
    if (kind !== 'directory' && !desired.has(entryPath)) {
      await rm(hostPath(realRoot, entryPath), { force: true });
      changed.add(entryPath);
    }
  }

  for (const entry of entries) {
    const target = hostPath(realRoot, entry.path);
    await ensureDirectory(realRoot, path.dirname(target));
    const existing = await lstat(target).catch(() => undefined);
    if (entry.type === 'symlink') {
      if (existing?.isSymbolicLink() && (await readlink(target)) === entry.target) continue;
      if (existing) await rm(target, { recursive: true, force: true });
      await symlink(entry.target, target);
    } else {
      const mode = entry.executable ? 0o755 : 0o644;
      if (
        existing?.isFile() &&
        ((existing.mode & 0o111) !== 0) === entry.executable &&
        (await readFile(target)).equals(entry.data)
      ) {
        continue;
      }
      if (existing && !existing.isFile()) await rm(target, { recursive: true, force: true });
      await writeFile(target, entry.data, { mode });
      await chmod(target, mode);
    }
    changed.add(entry.path);
  }
  return [...changed].sort();
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
