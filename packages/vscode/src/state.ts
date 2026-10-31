// Cached diagnose + Team status for the current folder, refreshed on demand.
// Fetches (network) at most every FETCH_INTERVAL_MS unless forced.
import {
  diagnose,
  NotAGitRepoError,
  teamStatus,
  type Diagnosis,
  type RemoteState,
  type TeamStatus,
} from "@branchguard/core";
import * as vscode from "vscode";
import type { GitApi } from "./git-api.js";
import { repoContext, type RepoContext } from "./repo.js";

const FETCH_INTERVAL_MS = 2 * 60 * 1000;

/** local: no network. auto: fetch if the last fetch is old. force: always fetch. */
export type RefreshKind = "local" | "auto" | "force";

export class BranchguardState {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  dir: string | undefined;
  diagnosis: Diagnosis | undefined;
  team: TeamStatus | undefined;
  /** Plain message when diagnose failed (other than "not a repo"). */
  error: string | undefined;
  /** Plain message when Team status failed, e.g. no main on the team repo. */
  teamError: string | undefined;
  noRepo = false;

  private readonly lastFetch = new Map<string, number>();
  private readonly knownRemote = new Map<string, RemoteState>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly gitApi: GitApi | undefined,
    private readonly log: (line: string) => void,
  ) {}

  context(): RepoContext | undefined {
    return repoContext(this.gitApi);
  }

  /** Refreshes one at a time, in order. */
  refresh(kind: RefreshKind): Promise<void> {
    this.queue = this.queue.then(() => this.doRefresh(kind)).catch(() => undefined);
    return this.queue;
  }

  private async doRefresh(kind: RefreshKind): Promise<void> {
    const ctx = this.context();
    this.dir = ctx?.dir;
    if (!ctx) {
      this.clear(false);
      return;
    }
    const last = this.lastFetch.get(ctx.dir) ?? 0;
    const fetch = kind === "force" || (kind === "auto" && Date.now() - last > FETCH_INTERVAL_MS);
    try {
      if (fetch) await this.refreshTeam(ctx, true);
      // Diagnose never fetches here: the team refresh above already did.
      this.diagnosis = await diagnose(ctx.dir, "main", {
        fetch: false,
        knownRemote: this.knownRemote.get(ctx.dir),
      });
      if (!fetch && !this.team) await this.refreshTeam(ctx, false);
      this.error = undefined;
      this.setNoRepo(false);
    } catch (error) {
      if (error instanceof NotAGitRepoError) {
        this.clear(true);
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.log(`Refresh failed: ${this.error}`);
    }
    this.changed.fire();
  }

  private async refreshTeam(ctx: RepoContext, fetch: boolean): Promise<void> {
    try {
      this.team = await teamStatus(ctx.dir, {
        fetch,
        knownRemote: this.knownRemote.get(ctx.dir),
        remoteOps: ctx.remoteOps,
      });
      this.teamError = undefined;
      if (fetch) {
        this.lastFetch.set(ctx.dir, Date.now());
        this.knownRemote.set(ctx.dir, {
          canReachRemote: this.team.canReachRemote,
          remoteProblem: this.team.remoteProblem,
        });
      }
    } catch (error) {
      if (error instanceof NotAGitRepoError) throw error;
      this.team = undefined;
      this.teamError = error instanceof Error ? error.message : String(error);
    }
  }

  private clear(noRepo: boolean): void {
    this.diagnosis = undefined;
    this.team = undefined;
    this.error = undefined;
    this.teamError = undefined;
    this.setNoRepo(noRepo);
    this.changed.fire();
  }

  private setNoRepo(value: boolean): void {
    this.noRepo = value;
    void vscode.commands.executeCommand("setContext", "branchguard.noRepo", value);
  }
}
