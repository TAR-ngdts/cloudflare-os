import { describe, expect, it } from "vitest";
import { approvalText, discardSource, newBranch, operationKey, operationStatus, runOperation, storeSource, type KvStore, type VibeAppOperation } from "../src/operations";
import type { PreparedSource } from "../src/source";

const filled = (bytes: number, value = 1) => { let out = ""; for (let i = 0; i < bytes; i += 0x8000) out += String.fromCharCode(value).repeat(Math.min(0x8000, bytes - i)); return btoa(out); };
const SHA_BASE = "a".repeat(40);
const SHA_COMMIT = "b".repeat(40);

function memoryKv(): KvStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string) => (data.has(key) ? structuredClone(data.get(key)) as T : undefined),
    put: (key, value) => { data.set(key, structuredClone(value)); },
    delete: key => data.delete(key),
  };
}

const source = (bytes = 10): PreparedSource => ({
  files: [{ path: "index.html", contentBase64: filled(bytes), mode: "100644" }],
  report: { framework: "static", canImport: true, findings: [], fileCount: 1, totalBytes: bytes },
  framework: "static",
  reviewFindings: [],
  totalBytes: bytes,
});

function stage(kv: KvStore, kind: "createVibeApp" | "importVibeApp" = "createVibeApp", bytes = 10): VibeAppOperation {
  const operation: VibeAppOperation = {
    type: kind, approvalId: 1, input: { businessUnit: "demo", slug: "app" }, branch: newBranch(kind), title: "Create VibeApp demo/app", name: "Demo App",
    framework: kind === "importVibeApp" ? "static" : "", gatewayFramework: kind === "importVibeApp" ? "static" : undefined,
    fileCount: kind === "importVibeApp" ? 1 : 0, totalBytes: kind === "importVibeApp" ? bytes : 0, reviewedFindingCodes: ["backend_code"], sourceChunks: 0, state: "pending", stages: {},
  };
  operation.sourceChunks = storeSource(kv, 1, kind === "importVibeApp" ? source(bytes) : null);
  kv.put(operationKey(1), operation);
  return operation;
}

type Call = { path: string; method: string; body: unknown };
function gateway(overrides: Record<string, (call: Call) => unknown> = {}) {
  const calls: Call[] = [];
  const call = async (path: string, method = "GET", body?: unknown) => {
    const record = { path, method, body };
    calls.push(record);
    const key = `${method} ${path.replace(/^\/api\/apps\/demo\/app/, "")}`;
    const handler = overrides[key];
    if (handler) return handler(record);
    if (key === "POST /api/apps") return { id: "demo/app", repo: "org/demo-app", workflowsSeeded: true };
    if (key === "GET /default-branch") return { branch: "main", sha: SHA_BASE };
    if (key === "POST /source-branches") return { branch: (body as { branch: string }).branch, commitSha: SHA_COMMIT, baseSha: SHA_BASE, files: 67, dropped: 2 };
    if (key === "POST /pulls") return { number: 7, url: "https://github.com/org/demo-app/pull/7", sha: SHA_COMMIT, autoMerge: { enabled: true } };
    throw new Error(`unexpected ${key}`);
  };
  return { calls, call };
}

describe("runOperation", () => {
  it("runs the full pipeline in order with truthful staged results", async () => {
    const kv = memoryKv(), gw = gateway(), operation = stage(kv);
    const done = await runOperation(kv, gw.call, operation);
    expect(gw.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "POST /api/apps", "GET /api/apps/demo/app/default-branch", "POST /api/apps/demo/app/source-branches", "POST /api/apps/demo/app/pulls",
    ]);
    const publish = gw.calls[2].body as { operation: string; branch: string; baseSha: string; name: string; files?: unknown };
    expect(publish).toMatchObject({ operation: "create", baseSha: SHA_BASE, name: "Demo App" });
    expect(publish).not.toHaveProperty("files");
    expect(publish.branch).toMatch(/^ng-dots\/create-[0-9a-f-]{36}$/);
    expect(gw.calls[3].body).toEqual({ branch: publish.branch, sha: SHA_COMMIT, title: "Create VibeApp demo/app" });
    const status = operationStatus(done);
    expect(status.state).toBe("completed");
    expect(status.stages).toEqual({
      repositoryProvisioned: true,
      sourceBranchCreated: { branch: publish.branch, commitSha: SHA_COMMIT, files: 67, dropped: 2 },
      pullRequestOpened: { number: 7, url: "https://github.com/org/demo-app/pull/7", autoMergeRequested: true },
    });
    expect(status.notObserved).toEqual(["merged", "deploymentQueued", "deployed", "liveVerified"]);
    expect(kv.data.has("operation:1:source:0")).toBe(false);
  });

  it("uses the import operation name for imports", async () => {
    const kv = memoryKv(), gw = gateway();
    await runOperation(kv, gw.call, stage(kv, "importVibeApp"));
    const body = gw.calls[2].body as { operation: string; branch: string; framework: string; name: string; files: unknown[]; importReport: unknown };
    expect(body).toMatchObject({ operation: "import", framework: "static", name: "Demo App", importReport: { reviewedFindingCodes: ["backend_code"] } });
    expect(body.branch).toMatch(/^ng-dots\/import-/);
    expect(body.files).toHaveLength(1);
  });

  it("propagates the exact gateway error, keeps finished stages, and resumes without repeating them", async () => {
    const kv = memoryKv(), operation = stage(kv);
    let fail = true;
    const gw = gateway({ "POST /source-branches": ({ body }) => { if (fail) throw new Error("base_changed"); return { branch: (body as { branch: string }).branch, commitSha: SHA_COMMIT }; } });
    await expect(runOperation(kv, gw.call, operation)).rejects.toThrow("base_changed");
    let stored = kv.get<VibeAppOperation>(operationKey(1))!;
    expect(stored.state).toBe("failed");
    expect(stored.lastError).toBe("base_changed");
    expect(operationStatus(stored).stages).toMatchObject({ repositoryProvisioned: true, sourceBranchCreated: null, pullRequestOpened: null });
    expect(operationStatus(stored).notObserved[0]).toBe("pullRequestOpened");
    expect(stored.baseSha).toBe(SHA_BASE);

    fail = false;
    const before = gw.calls.length;
    const resumed = await runOperation(kv, gw.call, stored);
    expect(resumed.state).toBe("completed");
    const retried = gw.calls.slice(before).map(c => `${c.method} ${c.path}`);
    expect(retried).toEqual(["POST /api/apps/demo/app/source-branches", "POST /api/apps/demo/app/pulls"]);
    // The persisted base SHA is reused so the gateway's digest idempotency applies.
    expect((gw.calls[gw.calls.length - 2].body as { baseSha: string }).baseSha).toBe(SHA_BASE);
    stored = kv.get<VibeAppOperation>(operationKey(1))!;
    expect(stored.lastError).toBeUndefined();
  });

  it("does nothing further for a completed operation", async () => {
    const kv = memoryKv(), gw = gateway(), operation = stage(kv);
    await runOperation(kv, gw.call, operation);
    const count = gw.calls.length;
    await runOperation(kv, gw.call, kv.get<VibeAppOperation>(operationKey(1))!);
    expect(gw.calls.length).toBe(count);
  });

  it("refuses concurrent runs but recovers an expired lease", async () => {
    const kv = memoryKv(), gw = gateway(), operation = stage(kv);
    operation.state = "running";
    operation.startedAt = 1_000;
    await expect(runOperation(kv, gw.call, operation, 1_000 + 60_000)).rejects.toThrow("operation_already_running");
    expect(gw.calls).toHaveLength(0);
    const recovered = await runOperation(kv, gw.call, operation, 1_000 + 6 * 60_000);
    expect(recovered.state).toBe("completed");
  });

  it("rejects malformed or mismatched gateway responses instead of recording stages", async () => {
    for (const [key, value, message] of [
      ["GET /default-branch", { sha: "main" }, "gateway_default_branch_invalid"],
      ["POST /source-branches", { branch: "ng-dots/other", commitSha: SHA_COMMIT }, "gateway_source_response_invalid"],
      ["POST /source-branches", { branch: "x", commitSha: "nope" }, "gateway_source_response_invalid"],
      ["POST /pulls", { number: "7", url: "https://x" }, "gateway_pull_response_invalid"],
      ["POST /pulls", { number: 7, url: "javascript:alert(1)" }, "gateway_pull_response_invalid"],
      ["POST /", "text", "gateway_app_response_invalid"],
      ["POST /", { id: "demo/app", workflowsSeeded: false }, "workflow_seed_unavailable"],
      ["POST /", { id: "demo/app" }, "workflow_seed_unavailable"],
    ] as const) {
      const kv = memoryKv(), operation = stage(kv);
      const gw = gateway({ [key === "POST /" ? "POST /api/apps" : key]: () => value });
      await expect(runOperation(kv, gw.call, operation)).rejects.toThrow(message);
      expect(kv.get<VibeAppOperation>(operationKey(1))!.state).toBe("failed");
    }
  });

  it("stores large sources in bounded chunks and reassembles them exactly", async () => {
    const kv = memoryKv(), operation = stage(kv, "importVibeApp", 2 * 1024 * 1024);
    expect(operation.sourceChunks).toBeGreaterThan(2);
    for (const [key, value] of kv.data) if (key.includes(":source:")) expect((value as string).length).toBeLessThanOrEqual(900_000);
    const gw = gateway();
    await runOperation(kv, gw.call, operation);
    const files = (gw.calls[2].body as { files: Array<{ contentBase64: string }> }).files;
    expect(atob(files[0].contentBase64).length).toBe(2 * 1024 * 1024);
  });

  it("fails clearly when staged source is missing", async () => {
    const kv = memoryKv(), operation = stage(kv, "importVibeApp");
    discardSource(kv, operation);
    await expect(runOperation(kv, gateway().call, operation)).rejects.toThrow("staged_source_missing");
  });
});

describe("approvalText", () => {
  it("states BU, slug, source summary, findings, branch and PR intent for an import without claiming merge or deploy", () => {
    const kv = memoryKv(), operation = stage(kv, "importVibeApp");
    const text = approvalText(operation, [{ severity: "review", code: "backend_code", path: "server", message: "Server-side code needs an explicit compatibility review." }]);
    for (const part of ["demo/app", "1 imported files", "**static**", "`frontend/`", operation.branch, "pull request into `main`", "backend_code", "Server-side code", "auto-merge", "not** part of this approval"]) {
      expect(text).toContain(part);
    }
    expect(text.startsWith("Import the VibeApp")).toBe(true);
  });

  it("describes the pinned template for a create and lists no findings", () => {
    const kv = memoryKv(), operation = stage(kv, "createVibeApp");
    const text = approvalText(operation, []);
    for (const part of ["Create the VibeApp **demo/app**", "pinned NG Dots starter template", '"Demo App"', operation.branch, "pull request into `main`", "not** part of this approval"]) expect(text).toContain(part);
    expect(text).not.toContain("Review findings");
  });
});
