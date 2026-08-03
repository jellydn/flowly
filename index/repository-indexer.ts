/**
 * Repository indexer and TF-IDF retriever.
 *
 * Builds an in-memory term-frequency / inverse-document-frequency index over
 * repository source and documentation files. The index is chunked into
 * ~50-line segments so retrieval results carry precise file paths and line
 * ranges for citation.
 *
 * The indexer reuses {@link RepositoryReader} for file discovery and reading,
 * so the same path-confinement, ignored-directory, and file-size limits apply.
 * No external embedding model or vector database is required.
 */

import type { RepositoryReader } from '../tools/repository.ts';
import { isDocumentationFile } from '../investigation/evidence.ts';
import { TOOL_LIMITS } from '../tools/contracts.ts';

const CHUNK_SIZE = 50;
const MAX_CHUNKS = 2_000;
const MIN_TOKEN_LENGTH = 2;
const STOP_WORDS = new Set([
  'the',
  'is',
  'at',
  'on',
  'and',
  'a',
  'an',
  'to',
  'of',
  'in',
  'for',
  'it',
  'or',
  'as',
  'by',
  'be',
  'this',
  'that',
  'with',
  'from',
  'are',
  'was',
  'but',
  'not',
  'they',
  'have',
  'has',
  'you',
  'we',
  'all',
  'can',
  'will',
  'if',
  'so',
  'no',
  'do',
  'use',
  'uses',
  'using',
  'used',
  'into',
  'out',
  'up',
  'down',
  'than',
  'then',
  'these',
  'those',
  'their',
  'there',
  'here',
  'when',
  'where',
  'what',
  'which',
  'who',
  'how',
  'why',
  'about',
  'above',
  'below',
  'over',
  'under',
  'again',
  'more',
  'most',
  'some',
  'any',
  'each',
  'other',
  'its',
  'our',
  'your',
  'their',
  'them',
  'his',
  'her',
  'she',
  'him',
  'he',
  'she',
  'been',
  'being',
  'were',
  'had',
  'having',
  'should',
  'would',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'also',
  'such',
  'only',
  'very',
  'just',
  'like',
  'one',
  'two',
  'via',
  'per',
  'new',
  'see',
  'set',
  'get',
  'let',
  'put',
  'say',
  'said',
  'way',
  'make',
  'made',
  'want',
  'needs',
  'need',
  'based',
  'call',
  'calls',
  'called',
]);

/** A chunk of a repository file with its line range. */
export type Chunk = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  sourceType: 'documentation' | 'code';
};

/** A scored retrieval result. */
export type RetrievalResult = {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  score: number;
  sourceType: 'documentation' | 'code';
};

/** Statistics about the index. */
export type IndexStats = {
  filesIndexed: number;
  chunksIndexed: number;
  uniqueTerms: number;
  buildTimeMs: number;
};

type PostingsEntry = {
  tf: number;
  chunkId: number;
};

type IndexedChunk = {
  chunk: Chunk;
  tfMap: Map<string, number>;
  norm: number;
};

/**
 * TF-IDF repository index. Built once from a {@link RepositoryReader}, then
 * queried any number of times via {@link retrieve}.
 */
export class RepositoryIndex {
  private chunks: IndexedChunk[] = [];
  private postings: Map<string, PostingsEntry[]> = new Map();
  private df: Map<string, number> = new Map();
  private _stats: IndexStats = {
    filesIndexed: 0,
    chunksIndexed: 0,
    uniqueTerms: 0,
    buildTimeMs: 0,
  };

  get stats(): IndexStats {
    return this._stats;
  }

  get size(): number {
    return this.chunks.length;
  }

  /** Add a chunk to the index. Called during build. */
  addChunk(chunk: Chunk): void {
    if (this.chunks.length >= MAX_CHUNKS) return;

    const tokens = tokenize(chunk.content);
    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }

    const chunkId = this.chunks.length;
    for (const [term, tf] of tfMap) {
      const existing = this.postings.get(term);
      if (existing) {
        existing.push({ tf, chunkId });
      } else {
        this.postings.set(term, [{ tf, chunkId }]);
      }
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }

    // Pre-compute L2 norm of TF-IDF vector for cosine similarity.
    const N = this.chunks.length + 1;
    let norm = 0;
    for (const [term, tf] of tfMap) {
      const idf = Math.log(1 + N / (this.df.get(term) ?? 1));
      const weight = tf * idf;
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;

    this.chunks.push({ chunk, tfMap, norm });
  }

  /** Finalize the index after all chunks are added. */
  finalize(buildTimeMs: number, filesIndexed: number): void {
    this._stats = {
      filesIndexed,
      chunksIndexed: this.chunks.length,
      uniqueTerms: this.postings.size,
      buildTimeMs,
    };
  }

  /**
   * Retrieve the top-K chunks matching a query using TF-IDF cosine similarity.
   */
  retrieve(query: string, topK = 5): RetrievalResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.chunks.length === 0) return [];

    const N = this.chunks.length;
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }

    // Compute query TF-IDF vector and norm.
    const queryWeights = new Map<string, number>();
    let queryNorm = 0;
    for (const [term, tf] of queryTf) {
      const df = this.df.get(term);
      if (!df) continue;
      const idf = Math.log(1 + N / df);
      const weight = tf * idf;
      queryWeights.set(term, weight);
      queryNorm += weight * weight;
    }
    queryNorm = Math.sqrt(queryNorm) || 1;

    // Score each chunk that shares at least one term with the query.
    const scored: Array<{ chunkId: number; score: number }> = [];
    const candidateIds = new Set<number>();
    for (const term of queryWeights.keys()) {
      for (const posting of this.postings.get(term) ?? []) {
        candidateIds.add(posting.chunkId);
      }
    }

    for (const chunkId of candidateIds) {
      const entry = this.chunks[chunkId];
      if (!entry) continue;

      let dot = 0;
      for (const [term, queryWeight] of queryWeights) {
        const tf = entry.tfMap.get(term);
        if (!tf) continue;
        const df = this.df.get(term) ?? 1;
        const idf = Math.log(1 + N / df);
        dot += queryWeight * (tf * idf);
      }
      const score = dot / (queryNorm * entry.norm);
      scored.push({ chunkId, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ chunkId, score }) => {
      const entry = this.chunks[chunkId];
      const chunk = entry.chunk;
      const excerptLines = chunk.content.split('\n').slice(0, 5);
      return {
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        excerpt: excerptLines.join('\n').slice(0, TOOL_LIMITS.maxSearchExcerptLength),
        score: Math.round(score * 1000) / 1000,
        sourceType: chunk.sourceType,
      };
    });
  }
}

/**
 * Build a repository index by reading source and documentation files through
 * the provided {@link RepositoryReader}. Files are chunked into ~50-line
 * segments and tokenized for TF-IDF scoring.
 */
export async function buildRepositoryIndex(repository: RepositoryReader): Promise<RepositoryIndex> {
  const start = Date.now();
  const index = new RepositoryIndex();
  let filesIndexed = 0;

  const [sourceFiles, docFiles] = await Promise.all([
    repository.sourceFiles('.'),
    repository.documentationFiles('.'),
  ]);

  const allFiles = new Set<string>([...sourceFiles, ...docFiles]);

  for (const filePath of allFiles) {
    try {
      const content = await repository.readText(filePath);
      const sourceType: 'documentation' | 'code' = isDocumentationFile(filePath)
        ? 'documentation'
        : 'code';
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        const chunkLines = lines.slice(i, i + CHUNK_SIZE);
        const chunkContent = chunkLines.join('\n');
        if (chunkContent.trim().length === 0) continue;
        index.addChunk({
          path: filePath,
          startLine: i + 1,
          endLine: Math.min(i + CHUNK_SIZE, lines.length),
          content: chunkContent,
          sourceType,
        });
      }
      filesIndexed += 1;
    } catch {
      // Skip unreadable files (binary, too large, etc.)
    }
  }

  index.finalize(Date.now() - start, filesIndexed);
  return index;
}

/**
 * Tokenize text into lowercase word tokens. Filters stop words and short
 * tokens. Splits camelCase and snake_case into separate tokens to improve
 * matching of identifiers like `issueToken` or `user_service`.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split on non-word characters first.
  const words = text.toLowerCase().split(/[^a-z0-9_]+/);
  for (const word of words) {
    if (word.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(word)) continue;
    tokens.push(word);
    // Split snake_case (e.g., user_service → user, service)
    // camelCase is already lost after lowercasing, but snake_case survives.
    const subWords = word.split(/_/).filter((s) => s.length >= MIN_TOKEN_LENGTH);
    for (const sub of subWords) {
      if (sub !== word && !STOP_WORDS.has(sub)) {
        tokens.push(sub);
      }
    }
  }
  return tokens;
}
