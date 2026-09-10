import type { Account, SendingIdentities } from "inbox-sdk/types";
import type { RecipientIdentity } from "./recipient-address";

export type RecipientIdentitySource = { sourceId: string; sourceGeneration: number };
type DemandScope = { storeGeneration: number; mode: "window" | "legacy"; signal: AbortSignal };
type IdentityRequest = RecipientIdentitySource & DemandScope & { demandEpoch: number };
type IdentityCache = { generation: number; checkedAt: number; identities: RecipientIdentity[] };

const IDENTITY_TTL_MS = 5 * 60_000;
const IDENTITY_CONCURRENCY = 4;
const sourceKey = (sourceId: string, generation: number) => `${sourceId}\0${generation}`;

/** Owns optional recipient metadata demand, cache freshness and request lifetime, not mail projection. */
export class RecipientIdentityLoader {
  private cache = new Map<string, IdentityCache>();
  private queue = new Map<string, IdentityRequest>();
  private loads = new Map<string, IdentityRequest>();
  private workers = new Set<Promise<void>>();
  private active = new Set<string>();
  private demandEpoch = 0;
  private controller = new AbortController();
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    load(sourceId: string, signal: AbortSignal): Promise<SendingIdentities>;
    isCurrent(sourceId: string, sourceGeneration: number, storeGeneration: number): boolean;
    changed(sourceId: string, mode: DemandScope["mode"]): void;
    refresh(): void;
  }) {}

  get(sourceId: string, generation: number): readonly RecipientIdentity[] | undefined {
    const cached = this.cache.get(sourceId);
    return cached?.generation === generation ? cached.identities : undefined;
  }

  hasDemand(sourceId: string, generation: number): boolean {
    return this.active.has(sourceKey(sourceId, generation));
  }

  prune(accounts: readonly Pick<Account, "id" | "generation" | "status">[]): void {
    for (const [sourceId, cached] of this.cache) {
      const source = accounts.find(account => account.id === sourceId);
      if (source?.status !== "connected" || source.generation !== cached.generation) this.cache.delete(sourceId);
    }
  }

  /** Retire a view's requests without discarding reusable source metadata. */
  reset(): void {
    this.demandEpoch++;
    this.controller.abort(); this.controller = new AbortController();
    this.queue.clear(); this.loads.clear(); this.workers.clear(); this.active.clear();
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
  }

  clear(): void {
    this.reset();
    this.cache.clear();
  }

  update(rows: readonly RecipientIdentitySource[], scope: DemandScope): void {
    const now = Date.now();
    const demand = new Map<string, RecipientIdentitySource>();
    for (const row of rows) {
      const key = sourceKey(row.sourceId, row.sourceGeneration);
      if (!demand.has(key)) demand.set(key, row);
    }
    this.active = new Set(demand.keys());
    // Paging may retire queued work without retiring the whole view.
    for (const [key, request] of this.queue) {
      if (this.active.has(key)) continue;
      this.queue.delete(key);
      if (this.loads.get(key) === request) this.loads.delete(key);
    }
    for (const [key, row] of demand) {
      if (!this.options.isCurrent(row.sourceId, row.sourceGeneration, scope.storeGeneration)) continue;
      const cached = this.cache.get(row.sourceId);
      if (cached?.generation === row.sourceGeneration && now - cached.checkedAt < IDENTITY_TTL_MS || this.loads.has(key)) continue;
      const request: IdentityRequest = { ...row, ...scope, demandEpoch: this.demandEpoch };
      this.loads.set(key, request);
      this.queue.set(key, request);
    }
    this.drain();
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    let next = Infinity;
    for (const [sourceId, cached] of this.cache) {
      const key = sourceKey(sourceId, cached.generation);
      if (this.active.has(key) && !this.loads.has(key)) next = Math.min(next, cached.checkedAt + IDENTITY_TTL_MS);
    }
    if (!Number.isFinite(next)) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.options.refresh();
    }, Math.max(1, next - Date.now()));
  }

  private drain(): void {
    while (this.workers.size < IDENTITY_CONCURRENCY && this.queue.size) {
      const [key, request] = this.queue.entries().next().value!;
      this.queue.delete(key);
      if (request.demandEpoch !== this.demandEpoch || !this.active.has(key)
        || !this.options.isCurrent(request.sourceId, request.sourceGeneration, request.storeGeneration)) {
        if (this.loads.get(key) === request) this.loads.delete(key);
        continue;
      }
      const signal = AbortSignal.any([this.controller.signal, request.signal]);
      let worker!: Promise<void>;
      worker = (async () => {
        let identities: RecipientIdentity[] = [];
        try {
          const result = await this.options.load(request.sourceId, signal);
          if (result.sourceId !== request.sourceId) throw new Error("Recipient identity source changed");
          identities = result.identities.map(identity => ({ email: identity.email, isPrimary: identity.isPrimary }));
        } catch {
          // Optional discovery failure keeps the upstream recipient fallback until the bounded cache expires.
        }
        if (signal.aborted || request.demandEpoch !== this.demandEpoch
          || !this.options.isCurrent(request.sourceId, request.sourceGeneration, request.storeGeneration)) return;
        const previous = this.cache.get(request.sourceId);
        this.cache.set(request.sourceId, { generation: request.sourceGeneration, checkedAt: Date.now(), identities });
        if (previous?.generation !== request.sourceGeneration || previous.identities.length !== identities.length
          || previous.identities.some((identity, index) => identity.email !== identities[index].email || identity.isPrimary !== identities[index].isPrimary)) {
          this.options.changed(request.sourceId, request.mode);
        }
      })().finally(() => {
        // A retired worker must not release a replacement request's slot or load ownership.
        if (!this.workers.delete(worker)) return;
        if (this.loads.get(key) === request) this.loads.delete(key);
        this.scheduleRefresh();
        this.drain();
      });
      this.workers.add(worker);
    }
  }
}
