import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RepositoryReader } from '../tools/repository.ts';
import { TOOL_LIMITS } from '../tools/contracts.ts';

export const RELATIONSHIP_TYPES = [
  'imports',
  'imported_by',
  'depends_on',
  'owned_by',
  'documented_by',
  'references_issue',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
export type RelationshipNodeKind = 'file' | 'directory' | 'package' | 'owner' | 'issue' | 'pull';

export type RelationshipNode = {
  id: string;
  kind: RelationshipNodeKind;
  label: string;
};

export type RelationshipCitation = {
  path: string;
  line: number;
  excerpt: string;
};

export type RelationshipEdge = {
  id: string;
  relationship: RelationshipType;
  source: RelationshipNode;
  target: RelationshipNode;
  citation: RelationshipCitation;
};

export type RelationshipDiagnostic = {
  path: string;
  message: string;
};

export type RelationshipIndexStats = {
  filesScanned: number;
  nodesIndexed: number;
  edgesIndexed: number;
  skippedEntries: number;
};

const MAX_DIAGNOSTICS = 50;
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const MANIFEST_NAMES = new Set(['package.json']);

export class RepositoryRelationshipIndex {
  private readonly nodesById = new Map<string, RelationshipNode>();
  private readonly edgesBySource = new Map<string, RelationshipEdge[]>();
  private readonly edgeIds = new Set<string>();

  constructor(
    readonly diagnostics: readonly RelationshipDiagnostic[],
    readonly stats: RelationshipIndexStats,
  ) {}

  addNode(node: RelationshipNode): RelationshipNode {
    const existing = this.nodesById.get(node.id);
    if (existing) return existing;
    this.nodesById.set(node.id, node);
    return node;
  }

  addEdge(edge: Omit<RelationshipEdge, 'id'>): void {
    const id = edgeId(edge);
    if (this.edgeIds.has(id)) return;
    this.edgeIds.add(id);
    const normalized = { ...edge, id };
    const edges = this.edgesBySource.get(edge.source.id) ?? [];
    edges.push(normalized);
    this.edgesBySource.set(edge.source.id, edges);
  }

  relationships(
    nodeId: string,
    relationship: RelationshipType | undefined,
    limit: number,
  ): RelationshipEdge[] {
    return (this.edgesBySource.get(nodeId) ?? [])
      .filter((edge) => relationship === undefined || edge.relationship === relationship)
      .sort(compareEdges)
      .slice(0, limit);
  }

  hasNode(nodeId: string): boolean {
    return this.nodesById.has(nodeId);
  }

  get nodeCount(): number {
    return this.nodesById.size;
  }

  get edgeCount(): number {
    return this.edgeIds.size;
  }
}

export async function buildRepositoryRelationshipIndex(
  repository: RepositoryReader,
): Promise<RepositoryRelationshipIndex> {
  const diagnostics: RelationshipDiagnostic[] = [];
  let skippedEntries = 0;
  const report = (path: string, message: string) => {
    skippedEntries += 1;
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ path, message });
  };

  const entries = await repository.list('.', 100);
  const filePaths = entries
    .filter(
      (entry) => entry.type === 'file' && (entry.size ?? Infinity) <= TOOL_LIMITS.maxFileBytes,
    )
    .map((entry) => entry.path)
    .sort();
  const files = new Set(filePaths);
  const index = new RepositoryRelationshipIndex(diagnostics, {
    filesScanned: 0,
    nodesIndexed: 0,
    edgesIndexed: 0,
    skippedEntries: 0,
  });

  index.addNode(repositoryNode('.', 'directory'));
  for (const entry of entries) {
    index.addNode(repositoryNode(entry.path, entry.type));
  }

  const codeowners: CodeownersRule[] = [];

  for (const filePath of filePaths) {
    let content: string;
    try {
      content = await repository.readText(filePath);
    } catch {
      report(filePath, 'Skipped unreadable or non-text file.');
      continue;
    }
    index.stats.filesScanned += 1;

    if (CODE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase())) {
      extractImports(index, files, filePath, content, report);
    }
    if (MANIFEST_NAMES.has(path.posix.basename(filePath))) {
      extractManifestDependencies(index, filePath, content, report);
    }
    if (/^(?:\.github\/|docs\/)?CODEOWNERS$/i.test(filePath)) {
      codeowners.push(...parseCodeowners(filePath, content, report));
    }
    if (/\.(?:md|markdown|txt)$/i.test(filePath)) {
      extractMarkdownRelationships(index, files, filePath, content, report);
    }
  }

  applyCodeowners(index, entries, codeowners, report);
  index.stats.nodesIndexed = index.nodeCount;
  index.stats.edgesIndexed = index.edgeCount;
  index.stats.skippedEntries = skippedEntries;
  return index;
}

function extractImports(
  index: RepositoryRelationshipIndex,
  files: Set<string>,
  sourcePath: string,
  content: string,
  report: (path: string, message: string) => void,
): void {
  const expression =
    /(?:\bimport\s+(?:[^'";]*?\s+from\s+)?|\bexport\s+[^'";]*?\s+from\s+|\brequire\s*\(|\bimport\s*\()(['"])(\.\.?\/[^'"]+)\1/g;
  for (const match of content.matchAll(expression)) {
    const specifier = match[2];
    if (!specifier) continue;
    const targetPath = resolveImport(sourcePath, specifier, files);
    if (!targetPath) {
      report(sourcePath, `Skipped unresolved relative import ${specifier}.`);
      continue;
    }
    const citation = citationFor(content, sourcePath, match.index, match[0]);
    const source = index.addNode(repositoryNode(sourcePath, 'file'));
    const target = index.addNode(repositoryNode(targetPath, 'file'));
    index.addEdge({ relationship: 'imports', source, target, citation });
    index.addEdge({ relationship: 'imported_by', source: target, target: source, citation });
  }
}

function resolveImport(
  sourcePath: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'].map(
      (extension) => `${base}${extension}`,
    ),
    ...['.ts', '.tsx', '.js', '.jsx'].map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function extractManifestDependencies(
  index: RepositoryRelationshipIndex,
  manifestPath: string,
  content: string,
  report: (path: string, message: string) => void,
): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    report(manifestPath, 'Skipped malformed package manifest.');
    return;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    report(manifestPath, 'Skipped package manifest with an invalid root value.');
    return;
  }

  const source = index.addNode(repositoryNode(manifestPath, 'file'));
  const object = manifest as Record<string, unknown>;
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const dependencies = object[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      report(manifestPath, `Skipped malformed ${field}.`);
      continue;
    }
    for (const dependency of Object.keys(dependencies as Record<string, unknown>).sort()) {
      const target = index.addNode(externalNode('package', dependency));
      const offset = content.indexOf(`"${dependency}"`);
      index.addEdge({
        relationship: 'depends_on',
        source,
        target,
        citation: citationFor(content, manifestPath, Math.max(0, offset), dependency),
      });
    }
  }
}

function parseCodeowners(
  codeownersPath: string,
  content: string,
  report: (path: string, message: string) => void,
): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const [offset, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0 || owners.some((owner) => !owner.startsWith('@'))) {
      report(codeownersPath, `Skipped malformed CODEOWNERS rule on line ${offset + 1}.`);
      continue;
    }
    rules.push({
      codeownersPath,
      pattern,
      owners,
      line: offset + 1,
      excerpt: rawLine.slice(0, 300),
    });
  }
  return rules;
}

function applyCodeowners(
  index: RepositoryRelationshipIndex,
  entries: Array<{ path: string; type: 'file' | 'directory' }>,
  rules: CodeownersRule[],
  report: (path: string, message: string) => void,
): void {
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    let matched: (typeof rules)[number] | undefined;
    for (const rule of rules) {
      try {
        if (codeownersPattern(rule.pattern).test(entry.path)) matched = rule;
      } catch {
        report(rule.codeownersPath, `Skipped unsupported CODEOWNERS pattern ${rule.pattern}.`);
      }
    }
    if (!matched) continue;
    const source = index.addNode(repositoryNode(entry.path, entry.type));
    for (const owner of matched.owners) {
      index.addEdge({
        relationship: 'owned_by',
        source,
        target: index.addNode(externalNode('owner', owner)),
        citation: {
          path: matched.codeownersPath,
          line: matched.line,
          excerpt: matched.excerpt,
        },
      });
    }
  }
}

type CodeownersRule = {
  codeownersPath: string;
  pattern: string;
  owners: string[];
  line: number;
  excerpt: string;
};

function codeownersPattern(pattern: string): RegExp {
  const anchored = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  let source = pattern.replace(/^\//, '').replace(/\/$/, '');
  source = source
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DOUBLE_STAR__/g, '.*');
  const prefix = anchored || pattern.includes('/') ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${source}${directory ? '(?:/.*)?' : ''}$`);
}

function extractMarkdownRelationships(
  index: RepositoryRelationshipIndex,
  files: Set<string>,
  sourcePath: string,
  content: string,
  report: (path: string, message: string) => void,
): void {
  const source = index.addNode(repositoryNode(sourcePath, 'file'));
  const links = /\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of content.matchAll(links)) {
    const href = match[1];
    if (!href || /^(?:https?:|mailto:|#)/i.test(href)) continue;
    const decoded = decodePath(href.split('#')[0] ?? '');
    const targetPath = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourcePath), decoded),
    );
    if (!files.has(targetPath)) {
      report(sourcePath, `Skipped unresolved Markdown link ${href}.`);
      continue;
    }
    const target = index.addNode(repositoryNode(targetPath, 'file'));
    index.addEdge({
      relationship: 'documented_by',
      source: target,
      target: source,
      citation: citationFor(content, sourcePath, match.index, match[0]),
    });
  }

  const references =
    /(?:https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/(\d+)|\b([\w.-]+\/[\w.-]+)?#(\d+))\b/g;
  for (const match of content.matchAll(references)) {
    const kind = match[1] === 'pull' ? 'pull' : 'issue';
    const number = match[2] ?? match[4];
    if (!number) continue;
    const target = index.addNode(externalNode(kind, `#${number}`));
    index.addEdge({
      relationship: 'references_issue',
      source,
      target,
      citation: citationFor(content, sourcePath, match.index, match[0]),
    });
  }
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function repositoryNode(label: string, kind: 'file' | 'directory'): RelationshipNode {
  return { id: `${kind}:${label}`, kind, label };
}

function externalNode(
  kind: 'package' | 'owner' | 'issue' | 'pull',
  label: string,
): RelationshipNode {
  return { id: `${kind}:${label}`, kind, label };
}

function edgeId(edge: Omit<RelationshipEdge, 'id'>): string {
  const value = [
    edge.relationship,
    edge.source.id,
    edge.target.id,
    edge.citation.path,
    edge.citation.line,
  ].join('\0');
  return `edge:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function compareEdges(left: RelationshipEdge, right: RelationshipEdge): number {
  return (
    left.relationship.localeCompare(right.relationship) ||
    left.target.id.localeCompare(right.target.id) ||
    left.citation.path.localeCompare(right.citation.path) ||
    left.citation.line - right.citation.line ||
    left.id.localeCompare(right.id)
  );
}

function citationFor(
  content: string,
  sourcePath: string,
  offset: number | undefined,
  excerpt: string,
): RelationshipCitation {
  const safeOffset = Math.max(0, offset ?? 0);
  return {
    path: sourcePath,
    line: content.slice(0, safeOffset).split(/\r?\n/).length,
    excerpt: excerpt.trim().slice(0, TOOL_LIMITS.maxSearchExcerptLength),
  };
}
