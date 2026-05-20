import chokidar, { type FSWatcher } from "chokidar";
import path from "path";

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
  tags: Set<string>;
}

interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  entries: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const WATCH_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.cache/**",
  "**/.turbo/**",
  "**/.sajicode/**",
];

export class IntelligentCache {
  private entries = new Map<string, CacheEntry<unknown>>();
  private watchers = new Map<string, FSWatcher>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    entries: 0,
  };

  async getOrSet<T>(
    key: string,
    generator: () => Promise<T>,
    options: { ttlMs?: number; tags?: string[] } = {},
  ): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;

    if (existing && existing.expiresAt > now) {
      this.stats.hits += 1;
      return existing.value;
    }

    if (existing) {
      this.entries.delete(key);
    }

    this.stats.misses += 1;
    const value = await generator();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    this.entries.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttlMs,
      tags: new Set(options.tags ?? []),
    });
    this.stats.entries = this.entries.size;

    return value;
  }

  invalidate(key: string): void {
    if (this.entries.delete(key)) {
      this.stats.invalidations += 1;
      this.stats.entries = this.entries.size;
    }
  }

  invalidateTag(tag: string): void {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.tags.has(tag)) {
        this.entries.delete(key);
        changed = true;
      }
    }

    if (changed) {
      this.stats.invalidations += 1;
      this.stats.entries = this.entries.size;
    }
  }

  clear(): void {
    if (this.entries.size > 0) {
      this.stats.invalidations += 1;
    }
    this.entries.clear();
    this.stats.entries = 0;
  }

  getStats(): CacheStats {
    return {
      ...this.stats,
      entries: this.entries.size,
    };
  }

  watchProject(projectPath: string): void {
    const normalizedProjectPath = path.resolve(projectPath);
    if (this.watchers.has(normalizedProjectPath)) return;

    const watcher = chokidar.watch(normalizedProjectPath, {
      ignored: WATCH_IGNORES,
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    const projectTag = projectCacheTag(normalizedProjectPath);
    const invalidate = () => this.invalidateTag(projectTag);

    watcher
      .on("add", invalidate)
      .on("change", invalidate)
      .on("unlink", invalidate)
      .on("addDir", invalidate)
      .on("unlinkDir", invalidate);

    this.watchers.set(normalizedProjectPath, watcher);
  }

  async closeWatchers(): Promise<void> {
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }
}

export const intelligentCache = new IntelligentCache();

export function projectCacheTag(projectPath: string): string {
  return `project:${path.resolve(projectPath).toLowerCase()}`;
}

export function makeCacheKey(parts: Array<string | number | boolean | undefined>): string {
  return parts
    .map((part) => String(part ?? ""))
    .join(":");
}
