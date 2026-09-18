import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { GatekeeperVendor, NgDotsGatekeeper, NgDotsSession, NgDotsUser, NgDotsUserAccount } from "../src/ng-dots";

const BASE_URL = "https://os.example.com/gatekeeper/ngdots";
const GATEWAY = "https://gateway.example.com/gateway";
const SHA_BASE = "a".repeat(40);
const SHA_COMMIT = "b".repeat(40);
const b64 = (text: string) => btoa(text);

type Kv = { get<T>(k: string): T | undefined; put(k: string, v: unknown): void; delete(k: string): boolean };
function kvStore(): Kv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    // RPC stubs (the connect callback) are stored by reference, as the real runtime persists them natively.
    get: <T,>(k: string) => (data.has(k) ? (k === "callback" ? data.get(k) : structuredClone(data.get(k))) as T : undefined),
    put: (k, v) => { data.set(k, k === "callback" || typeof v !== "object" || v === null ? v : structuredClone(v)); },
    delete: k => data.delete(k),
  };
}

/** Wires real Gatekeeper classes together with in-memory Durable Object storage. */
function world() {
  const accounts = new Map<string, { instance: NgDotsUserAccount; kv: ReturnType<typeof kvStore>; alarm: number | null }>();
  const env = { BASE_URL, GATEWAY_URL: GATEWAY } as never;
  let counter = 0;
  const exportsObj: any = {
    NgDotsUserAccount: {
      newUniqueId: () => { const id = (++counter).toString(16).padStart(64, "0"); return { toString: () => id }; },
      idFromString: (id: string) => ({ toString: () => id }),
      get: (id: { toString(): string }) => {
        const key = id.toString();
        if (!accounts.has(key)) {
          const kv = kvStore();
          const entry: { instance: NgDotsUserAccount; kv: typeof kv; alarm: number | null } = { instance: undefined as never, kv, alarm: null };
          const ctx = {
            id: { toString: () => key },
            exports: exportsObj,
            storage: {
              kv,
              setAlarm: async (t: number) => { entry.alarm = t; },
              deleteAlarm: async () => { entry.alarm = null; },
              deleteAll: async () => { kv.data.clear(); },
            },
          };
          entry.instance = new NgDotsUserAccount(ctx as never, env);
          accounts.set(key, entry);
        }
        return accounts.get(key)!.instance;
      },
    },
    NgDotsUser: ({ props }: { props: { userObjectId: string } }) => new NgDotsUser({ exports: exportsObj, props } as never, env),
    NgDotsVerifier: () => ({}),
    NgDotsGatekeeper: () => ({}),
  };
  const gatekeeperKv = kvStore();
  const gatekeeperFor = (userObjectId: string) => new NgDotsGatekeeper({ exports: exportsObj, props: { userObjectId }, storage: { kv: gatekeeperKv } } as never, env);
  return { env, exportsObj, accounts, gatekeeperFor, gatekeeperKv };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; url: URL; body: any; auth: string | null }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = url.pathname.replace("/gateway/plugin", "");
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init.headers).get("authorization") });
    const handler = handlers[`${method} ${path}`];
    if (!handler) return Response.json({ error: "not_found" }, { status: 404 });
    return handler(url, init);
  });
  return calls;
}
const gatewayJson = (data: unknown, status = 200) => Response.json(data, { status });

async function connectedAccount(w: ReturnType<typeof world>, { expiresIn = 3600 } = {}) {
  const complete = vi.fn(async () => ({ targetOrigin: "https://workshop.example.com", ticket: "ticket-1" }));
  const credentialsExpired = vi.fn(async () => {});
  const reconnectComplete = vi.fn(async () => ({ targetOrigin: "https://workshop.example.com", ticket: "ticket-2" }));
  const vendor = new GatekeeperVendor({ exports: w.exportsObj } as never, w.env);
  const { url } = await vendor.connectAccount({ complete, credentialsExpired, reconnectComplete } as never);
  const [, id, nonce] = url.slice(BASE_URL.length).split("/");
  return { id, nonce, url, complete, credentialsExpired, expiresIn };
}

function session(w: ReturnType<typeof world>, id: string) {
  const queue = {
    authorizeObservation: vi.fn(async () => {}),
    submitAction: vi.fn(async () => {}),
    dup() { return queue; },
  };
  const gatekeeper = w.gatekeeperFor(id);
  return { gatekeeper, queue, session: new NgDotsSession(gatekeeper, queue as never) };
}

// crypto.subtle.timingSafeEqual is a Workers-only extension.
(crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual ??= (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("hosted connection callback", () => {
  it("completes the PKCE handshake with the strict gateway callback shape and rejects replay", async () => {
    const w = world();
    const acct = await connectedAccount(w);
    const calls = stubFetch({
      "POST /auth/token": async (_u, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.code).toBe("gateway-code");
        expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return gatewayJson({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      },
    });
    const ctx = { exports: w.exportsObj } as never;

    const start = await worker.fetch(new Request(acct.url), w.env, ctx);
    expect(start.status).toBe(302);
    const login = new URL(start.headers.get("location")!);
    expect(`${login.origin}${login.pathname}`).toBe(`${GATEWAY}/auth/login`);
    expect(login.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const returnUrl = login.searchParams.get("return_url")!;
    // Must satisfy the gateway allowlist contract: <base>/oauth/<64 hex>/<43 base64url>, no query or fragment.
    expect(returnUrl).toMatch(new RegExp(`^${BASE_URL.replaceAll(".", "\\.")}/oauth/[0-9a-f]{64}/[A-Za-z0-9_-]{43}$`));

    // The initiation link is single use.
    expect((await worker.fetch(new Request(acct.url), w.env, ctx)).status).toBe(400);

    const done = await worker.fetch(new Request(`${returnUrl}?code=gateway-code`), w.env, ctx);
    expect(done.status).toBe(200);
    expect(acct.complete).toHaveBeenCalledTimes(1);
    expect(calls.filter(c => c.url.pathname.endsWith("/auth/token"))).toHaveLength(1);
    const stored = w.accounts.get(acct.id)!.kv;
    expect(stored.get("accessToken")).toBe("at");
    expect(stored.get("refreshToken")).toBe("rt");

    // Replay and tampering fail without another token exchange.
    expect((await worker.fetch(new Request(`${returnUrl}?code=gateway-code`), w.env, ctx)).status).toBe(400);
    expect(calls.filter(c => c.url.pathname.endsWith("/auth/token"))).toHaveLength(1);
  });

  it("rejects malformed, wrong-nonce and code-less callbacks", async () => {
    const w = world();
    const acct = await connectedAccount(w);
    stubFetch({});
    const ctx = { exports: w.exportsObj } as never;
    const start = await worker.fetch(new Request(acct.url), w.env, ctx);
    const returnUrl = new URL(start.headers.get("location")!).searchParams.get("return_url")!;
    expect((await worker.fetch(new Request(returnUrl), w.env, ctx)).status).toBe(400);
    const wrong = returnUrl.replace(/\/[^/]+$/, `/${"x".repeat(43)}`);
    expect((await worker.fetch(new Request(`${wrong}?code=c`), w.env, ctx)).status).toBe(400);
    expect((await worker.fetch(new Request(`${BASE_URL}/oauth/short/short?code=c`), w.env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://os.example.com/elsewhere"), w.env, ctx)).status).toBe(404);
    expect(acct.complete).not.toHaveBeenCalled();
  });

  it("clears credentials when the connection callback fails", async () => {
    const w = world();
    const acct = await connectedAccount(w);
    acct.complete.mockRejectedValueOnce(new Error("boom"));
    stubFetch({ "POST /auth/token": () => gatewayJson({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) });
    const ctx = { exports: w.exportsObj } as never;
    const start = await worker.fetch(new Request(acct.url), w.env, ctx);
    const returnUrl = new URL(start.headers.get("location")!).searchParams.get("return_url")!;
    await expect(worker.fetch(new Request(`${returnUrl}?code=c`), w.env, ctx)).rejects.toThrow("boom");
    expect(w.accounts.get(acct.id)!.kv.get("refreshToken")).toBeUndefined();
  });
});

async function connected(w: ReturnType<typeof world>) {
  const acct = await connectedAccount(w);
  const account = w.exportsObj.NgDotsUserAccount.get({ toString: () => acct.id }) as NgDotsUserAccount;
  account.saveCredentials({ accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
  return { ...acct, account };
}

describe("governed reads", () => {
  it("authorizes each observation before returning data", async () => {
    const w = world();
    const acct = await connected(w);
    const calls = stubFetch({
      "GET /api/me": () => gatewayJson({ email: "a@b.c" }),
      "GET /api/apps": () => gatewayJson({ apps: [] }),
      "GET /api/models": () => gatewayJson({ models: [] }),
      "GET /api/apps/demo/app": () => gatewayJson({ id: "demo/app" }),
    });
    const { session: s, queue } = session(w, acct.id);
    expect(await s.getIdentity()).toEqual({ email: "a@b.c" });
    await s.listApps();
    await s.listModels();
    expect(await s.getApp("demo/app")).toEqual({ id: "demo/app" });
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(4);
    expect(calls.every(c => c.auth === "Bearer at")).toBe(true);
    await expect(s.getApp("../../etc")).rejects.toThrow("invalid_app_id");
    expect(calls).toHaveLength(4);
  });

  it("does not return data when observation is denied", async () => {
    const w = world();
    const acct = await connected(w);
    stubFetch({ "GET /api/me": () => gatewayJson({ email: "secret@b.c" }) });
    const { session: s, queue } = session(w, acct.id);
    queue.authorizeObservation.mockRejectedValueOnce(new Error("denied"));
    await expect(s.getIdentity()).rejects.toThrow("denied");
  });

  it("inspects imports through observation authorization without calling the gateway", async () => {
    const w = world();
    const acct = await connected(w);
    const calls = stubFetch({});
    const { session: s, queue } = session(w, acct.id);
    const report = await s.inspectImport({ files: [{ path: ".env", size: 1 }, { path: "index.html", size: 1 }] });
    expect(report.canImport).toBe(false);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

const sourceFiles = () => [
  { path: "package.json", contentBase64: b64(JSON.stringify({ devDependencies: { vite: "^7" } })) },
  { path: "pnpm-lock.yaml", contentBase64: b64("lock") },
  { path: "src/main.tsx", contentBase64: b64("console.log(1)") },
];

function pipelineHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "POST /api/apps": () => gatewayJson({ id: "demo/app", repo: "org/demo-app" }, 201),
    "GET /api/apps/demo/app/default-branch": () => gatewayJson({ branch: "main", sha: SHA_BASE }),
    "POST /api/apps/demo/app/source-branches": (_u, init) => gatewayJson({ branch: JSON.parse(String(init.body)).branch, commitSha: SHA_COMMIT, baseSha: SHA_BASE }, 201),
    "POST /api/apps/demo/app/pulls": () => gatewayJson({ number: 12, url: "https://github.com/org/demo-app/pull/12", sha: SHA_COMMIT, autoMerge: { enabled: false, reason: "policy" } }),
    ...overrides,
  };
}

describe("createVibeApp and importVibeApp", () => {
  it("submits one approval with full context and sends nothing to the gateway before approval", async () => {
    const w = world();
    const acct = await connected(w);
    const calls = stubFetch(pipelineHandlers());
    const { session: s, queue } = session(w, acct.id);
    const { approvalId } = await s.createVibeApp({ businessUnit: "demo", slug: "app", files: sourceFiles() });
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    const [id, request] = queue.submitAction.mock.calls[0] as unknown as [number, { title: string; description: string; awaitDecision: boolean; actionKind: { tag: string } }];
    expect(id).toBe(approvalId);
    expect(request.awaitDecision).toBe(true);
    expect(request.actionKind.tag).toBe("ng-dots.create-vibe-app");
    expect(request.title).toContain("demo/app");
    expect(request.description).toMatch(/3 files/);
    expect(request.description).toMatch(/ng-dots\/create-[0-9a-f-]{36}/);
    expect(request.description).toMatch(/pull request into `main`/);
    expect(calls).toHaveLength(0);
    expect((await s.getVibeAppOperation(approvalId) as any).state).toBe("pending");
  });

  it("applies the approved operation through the gateway and reports only observed stages", async () => {
    const w = world();
    const acct = await connected(w);
    const calls = stubFetch(pipelineHandlers());
    const { session: s, gatekeeper } = session(w, acct.id);
    const { approvalId } = await s.importVibeApp({ businessUnit: "demo", slug: "app", files: sourceFiles() });
    await gatekeeper.applyAction(approvalId);
    expect(calls.map(c => `${c.method} ${c.url.pathname.replace("/gateway/plugin", "")}`)).toEqual([
      "POST /api/apps", "GET /api/apps/demo/app/default-branch", "POST /api/apps/demo/app/source-branches", "POST /api/apps/demo/app/pulls",
    ]);
    expect(calls[2].body.operation).toBe("import");
    expect(calls[2].body.files).toHaveLength(3);
    const status = await s.getVibeAppOperation(approvalId) as any;
    expect(status.state).toBe("completed");
    expect(status.stages.pullRequestOpened).toEqual({ number: 12, url: "https://github.com/org/demo-app/pull/12", autoMergeRequested: false });
    expect(status.notObserved).toEqual(["merged", "deploymentQueued", "deployed", "liveVerified"]);
    // A completed action cannot be applied twice.
    await expect(gatekeeper.applyAction(approvalId)).rejects.toThrow("not pending");
    expect(calls).toHaveLength(4);
  });

  it("propagates the exact gateway error and resumes idempotently on retry", async () => {
    const w = world();
    const acct = await connected(w);
    let mainMoved = true;
    const calls = stubFetch(pipelineHandlers({
      "POST /api/apps/demo/app/source-branches": (_u, init) => mainMoved
        ? gatewayJson({ error: "base_changed" }, 409)
        : gatewayJson({ branch: JSON.parse(String(init.body)).branch, commitSha: SHA_COMMIT }, 201),
    }));
    const { session: s, gatekeeper } = session(w, acct.id);
    const { approvalId } = await s.createVibeApp({ businessUnit: "demo", slug: "app", files: sourceFiles() });
    await expect(gatekeeper.applyAction(approvalId)).rejects.toMatchObject({ message: "base_changed", status: 409 });
    let status = await s.getVibeAppOperation(approvalId) as any;
    expect(status).toMatchObject({ state: "failed", lastError: "base_changed" });
    expect(status.stages).toMatchObject({ repositoryProvisioned: true, sourceBranchCreated: null, pullRequestOpened: null });

    mainMoved = false;
    const before = calls.length;
    await gatekeeper.applyAction(approvalId);
    expect(calls.slice(before).map(c => c.method + " " + c.url.pathname.split("/").pop())).toEqual(["POST source-branches", "POST pulls"]);
    status = await s.getVibeAppOperation(approvalId);
    expect(status.state).toBe("completed");
    // The same branch and base were used on both attempts.
    const attempts = calls.filter(c => c.url.pathname.endsWith("/source-branches"));
    expect(attempts[0].body.branch).toBe(attempts[1].body.branch);
    expect(attempts[0].body.baseSha).toBe(attempts[1].body.baseSha);
  });

  it("fails before approval for blocked, unacknowledged or malformed requests", async () => {
    const w = world();
    const acct = await connected(w);
    const calls = stubFetch(pipelineHandlers());
    const { session: s, queue } = session(w, acct.id);
    await expect(s.createVibeApp({ businessUnit: "Demo", slug: "app", files: sourceFiles() })).rejects.toThrow("valid_business_unit_required");
    await expect(s.createVibeApp({ businessUnit: "demo", slug: "app", files: [...sourceFiles(), { path: ".env", contentBase64: b64("K=v") }] })).rejects.toThrow(/source_blocked: secret_file/);
    await expect(s.importVibeApp({ businessUnit: "demo", slug: "app", files: [{ path: "index.html", contentBase64: b64("<p>") }] })).rejects.toThrow(/review_findings_require_acknowledgement: missing_lockfile/);
    expect(queue.submitAction).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("discards staged state when the queue refuses the action, and on rejection", async () => {
    const w = world();
    const acct = await connected(w);
    stubFetch(pipelineHandlers());
    const { session: s, queue, gatekeeper } = session(w, acct.id);
    queue.submitAction.mockRejectedValueOnce(new Error("queue_down"));
    await expect(s.createVibeApp({ businessUnit: "demo", slug: "app", files: sourceFiles() })).rejects.toThrow("queue_down");
    expect([...w.gatekeeperKv.data.keys()].filter(k => k.startsWith("operation:"))).toEqual([]);

    const { approvalId } = await s.createVibeApp({ businessUnit: "demo", slug: "app", files: sourceFiles() });
    await gatekeeper.rejectAction(approvalId);
    expect([...w.gatekeeperKv.data.keys()].filter(k => k.startsWith("operation:"))).toEqual([]);
    await expect(gatekeeper.applyAction(approvalId)).rejects.toThrow("not pending");
    await expect(gatekeeper.rejectAction(approvalId)).rejects.toThrow("Unknown NG Dots action");
    await expect(s.getVibeAppOperation(approvalId)).rejects.toThrow("Unknown NG Dots operation");
    expect(() => gatekeeper.revertAction(approvalId)).toThrow("cannot be reverted");
  });
});

describe("credential lifecycle", () => {
  it("refreshes near expiry, retries once after 401, and notifies expiry once when refresh is rejected", async () => {
    const w = world();
    const acct = await connectedAccount(w);
    const account = w.exportsObj.NgDotsUserAccount.get({ toString: () => acct.id }) as NgDotsUserAccount;
    account.saveCredentials({ accessToken: "old", refreshToken: "rt1", expiresAt: Date.now() + 1_000 });
    const calls = stubFetch({
      "POST /auth/refresh": () => gatewayJson({ access_token: "new", refresh_token: "rt2", expires_in: 3600 }),
      "GET /api/me": (_u, init) => new Headers(init.headers).get("authorization") === "Bearer new" ? gatewayJson({ email: "a@b.c" }) : gatewayJson({ error: "unauthorized" }, 401),
    });
    const { session: s } = session(w, acct.id);
    expect(await s.getIdentity()).toEqual({ email: "a@b.c" });
    expect(calls.filter(c => c.url.pathname.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(w.accounts.get(acct.id)!.kv.get("refreshToken")).toBe("rt2");

    vi.unstubAllGlobals();
    account.saveCredentials({ accessToken: "dead", refreshToken: "rt3", expiresAt: Date.now() + 1_000 });
    stubFetch({ "POST /auth/refresh": () => gatewayJson({ error: "invalid_refresh" }, 401) });
    await expect(s.getIdentity()).rejects.toMatchObject({ message: "invalid_refresh", status: 401 });
    await expect(s.getIdentity()).rejects.toMatchObject({ status: 401 });
    expect(acct.credentialsExpired).toHaveBeenCalledTimes(1);
  });

  it("reports missing credentials without calling the gateway", async () => {
    const w = world();
    const acct = await connectedAccount(w);
    const calls = stubFetch({});
    const { session: s } = session(w, acct.id);
    await expect(s.getIdentity()).rejects.toThrow("credentials are unavailable");
    expect(calls).toHaveLength(0);
  });
});
