import type { ImportFinding } from "./import-analysis";
import type { PreparedSource } from "./source";

export type OperationKind = "createVibeApp" | "importVibeApp";
export type OperationState = "staged" | "pending" | "running" | "failed" | "completed";

export type VibeAppOperation = {
  type: OperationKind;
  approvalId: number;
  input: { businessUnit: string; slug: string };
  branch: string;
  title: string;
  framework: string;
  fileCount: number;
  totalBytes: number;
  reviewedFindingCodes: string[];
  sourceChunks: number;
  state: OperationState;
  startedAt?: number;
  baseSha?: string;
  /** Each stage is recorded only after the gateway response for it was validated. Later states are never inferred. */
  stages: {
    repositoryProvisioned?: { repository?: string };
    sourceBranchCreated?: { branch: string; commitSha: string };
    pullRequestOpened?: { number: number; url: string; autoMergeRequested: boolean };
  };
  lastError?: string;
};

export type KvStore = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): unknown;
};

export type GatewayCall = (path: string, method?: string, body?: unknown) => Promise<unknown>;

const CHUNK_CHARS = 900_000;
const RUN_LEASE_MS = 5 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;

export const NOT_OBSERVED = ["merged", "deploymentQueued", "deployed", "liveVerified"] as const;

export function newBranch(kind: OperationKind): string {
  return `ng-dots/${kind === "createVibeApp" ? "create" : "import"}-${crypto.randomUUID()}`;
}

export function operationKey(id: number): string { return `operation:${id}`; }
function sourceKey(id: number, index: number): string { return `operation:${id}:source:${index}`; }

/** DO storage values are capped near 2 MB, so the manifest is stored as JSON in bounded chunks. */
export function storeSource(kv: KvStore, id: number, source: PreparedSource): number {
  const json = JSON.stringify(source.files);
  let count = 0;
  for (let offset = 0; offset < json.length; offset += CHUNK_CHARS) kv.put(sourceKey(id, count++), json.slice(offset, offset + CHUNK_CHARS));
  return count;
}

function loadSource(kv: KvStore, operation: VibeAppOperation): PreparedSource["files"] {
  let json = "";
  for (let index = 0; index < operation.sourceChunks; index++) {
    const chunk = kv.get<string>(sourceKey(operation.approvalId, index));
    if (chunk === undefined) throw new Error("staged_source_missing");
    json += chunk;
  }
  return JSON.parse(json) as PreparedSource["files"];
}

export function discardSource(kv: KvStore, operation: VibeAppOperation): void {
  for (let index = 0; index < operation.sourceChunks; index++) kv.delete(sourceKey(operation.approvalId, index));
}

export function approvalText(operation: VibeAppOperation, reviewFindings: ImportFinding[]): string {
  const { businessUnit, slug } = operation.input;
  const verb = operation.type === "createVibeApp" ? "Create" : "Import";
  const findings = reviewFindings.length
    ? reviewFindings.map(finding => `- **${finding.code}**${finding.path ? ` (${finding.path})` : ""}: ${finding.message}`).join("\n")
    : "- None.";
  return [
    `${verb} the VibeApp **${businessUnit}/${slug}** in NG Dots.`,
    "",
    `- Source: ${operation.fileCount} files, ${(operation.totalBytes / 1024).toFixed(1)} KiB, framework **${operation.framework}**.`,
    `- Branch: \`${operation.branch}\` (a new branch; \`main\` is never written directly).`,
    "- Steps: provision the governed private repository if it does not exist, publish this source to the branch, then open a pull request into `main`.",
    "- The pull request is subject to the repository's required checks and review rules, and NG Dots may enable auto-merge on it. Merge and deployment are **not** part of this approval and are reported only once observed.",
    "",
    "Review findings you are accepting:",
    findings,
  ].join("\n");
}

export function operationStatus(operation: VibeAppOperation) {
  const { stages } = operation;
  return {
    approvalId: operation.approvalId,
    operation: operation.type,
    appId: `${operation.input.businessUnit}/${operation.input.slug}`,
    state: operation.state,
    branch: operation.branch,
    stages: {
      repositoryProvisioned: Boolean(stages.repositoryProvisioned),
      sourceBranchCreated: stages.sourceBranchCreated ?? null,
      pullRequestOpened: stages.pullRequestOpened ?? null,
    },
    notObserved: stages.pullRequestOpened ? [...NOT_OBSERVED] : ["pullRequestOpened", ...NOT_OBSERVED],
    lastError: operation.lastError ?? null,
  };
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

/**
 * Resumable, idempotent pipeline. Every gateway step is safe to repeat: repository provisioning reconciles an existing
 * registry entry, source publication is keyed by branch + content digest against a persisted base SHA, and pull creation
 * reuses an open pull for the branch. A failure records the exact gateway error and leaves finished stages intact.
 */
export async function runOperation(kv: KvStore, call: GatewayCall, operation: VibeAppOperation, now = Date.now()): Promise<VibeAppOperation> {
  const key = operationKey(operation.approvalId);
  if (operation.state === "completed") return operation;
  if (operation.state === "running" && operation.startedAt && now - operation.startedAt < RUN_LEASE_MS) throw new Error("operation_already_running");
  operation.state = "running";
  operation.startedAt = now;
  delete operation.lastError;
  kv.put(key, operation);
  const { businessUnit, slug } = operation.input;
  const appPath = `/api/apps/${businessUnit}/${slug}`;
  try {
    if (!operation.stages.repositoryProvisioned) {
      const app = object(await call("/api/apps", "POST", operation.input), "gateway_app_response_invalid");
      operation.stages.repositoryProvisioned = { repository: typeof app.repo === "string" ? app.repo : undefined };
      kv.put(key, operation);
    }

    if (!operation.stages.sourceBranchCreated) {
      if (!operation.baseSha) {
        const base = object(await call(`${appPath}/default-branch`), "gateway_default_branch_invalid");
        if (typeof base.sha !== "string" || !SHA.test(base.sha)) throw new Error("gateway_default_branch_invalid");
        operation.baseSha = base.sha;
        kv.put(key, operation);
      }
      const published = object(await call(`${appPath}/source-branches`, "POST", {
        operation: operation.type === "createVibeApp" ? "create" : "import",
        branch: operation.branch,
        baseSha: operation.baseSha,
        files: loadSource(kv, operation),
        importReport: { framework: operation.framework, reviewedFindingCodes: operation.reviewedFindingCodes },
      }), "gateway_source_response_invalid");
      if (published.branch !== operation.branch || typeof published.commitSha !== "string" || !SHA.test(published.commitSha)) {
        throw new Error("gateway_source_response_invalid");
      }
      operation.stages.sourceBranchCreated = { branch: operation.branch, commitSha: published.commitSha };
      kv.put(key, operation);
    }

    if (!operation.stages.pullRequestOpened) {
      const { commitSha } = operation.stages.sourceBranchCreated;
      const pull = object(await call(`${appPath}/pulls`, "POST", { branch: operation.branch, sha: commitSha, title: operation.title }), "gateway_pull_response_invalid");
      if (!Number.isSafeInteger(pull.number) || typeof pull.url !== "string" || !pull.url.startsWith("https://")) throw new Error("gateway_pull_response_invalid");
      const autoMerge = pull.autoMerge && typeof pull.autoMerge === "object" ? (pull.autoMerge as { enabled?: unknown }).enabled === true : false;
      operation.stages.pullRequestOpened = { number: pull.number as number, url: pull.url, autoMergeRequested: autoMerge };
    }
    operation.state = "completed";
    discardSource(kv, operation);
    kv.put(key, operation);
    return operation;
  } catch (error) {
    operation.state = "failed";
    operation.lastError = error instanceof Error ? error.message : "operation_failed";
    kv.put(key, operation);
    throw error;
  }
}
