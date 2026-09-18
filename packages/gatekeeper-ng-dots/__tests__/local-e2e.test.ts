import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GatekeeperVendor, NgDotsGatekeeper, NgDotsSession, NgDotsUser, NgDotsUserAccount } from "../src/ng-dots";

/**
 * Opt-in local end-to-end run: the real Gatekeeper classes talk to the real gateway routes and template renderer, with an
 * in-memory GitHub. The resulting branch trees are written to disk so the generated apps can be built and tested.
 *
 *   NG_DOTS_GATEWAY_DIR=<gateway checkout> NG_DOTS_BOILERPLATE_DIR=<boilerplate checkout> NG_DOTS_E2E_OUT=<empty dir> vitest run local-e2e
 */
const gatewayDir = process.env.NG_DOTS_GATEWAY_DIR;
const boilerplateDir = process.env.NG_DOTS_BOILERPLATE_DIR;
const outDir = process.env.NG_DOTS_E2E_OUT;
const enabled = Boolean(gatewayDir && boilerplateDir && outDir && existsSync(gatewayDir) && existsSync(boilerplateDir));

const BASE_URL = "https://os.example.com/gatekeeper/ngdots";
const GATEWAY = "https://gateway.example.com/gateway";
const ORG = "nextgendots";
const b64 = (text: string) => btoa(text);
const REF = "c3991a41a84806fecf5169e902c607ef288c7e26";

type Tree = Map<string, { content?: string; sha?: string; mode: string }>;
type Commit = { message: string; parents: string[]; tree: Tree };

/** Just enough git object storage for the gateway's publish path. */
function fakeGithub() {
  const commits = new Map<string, Commit>();
  const blobs = new Map<string, string>();
  const refs = new Map<string, string>();
  const pulls: Array<{ repo: string; number: number; head: string; title: string }> = [];
  let counter = 0, repoCount = 0;
  const sha = () => (++counter).toString(16).padStart(40, "0");
  const notFound = () => Object.assign(new Error("github_404"), { status: 404 });
  const commit = (repo: string, message: string, parents: string[], tree: Tree) => {
    const id = sha();
    commits.set(id, { message, parents, tree });
    return id;
  };
  const mainKey = (repo: string) => `${repo}#refs/heads/main`;
  return {
    commits, blobs, refs, pulls,
    seed(repo: string) {
      refs.set(mainKey(repo), commit(repo, "Seed NG Dots protected workflows", [], new Map([
        [".github/workflows/deploy.yml", { content: "# seeded by the gateway\n", mode: "100644" }],
        ["README.md", { content: "# empty\n", mode: "100644" }],
      ])));
    },
    async call(_path: string, options: { method?: string } = {}) {
      if (_path === `/orgs/${ORG}`) return { default_repository_permission: "none" };
      if (_path === `/orgs/${ORG}/repos` && options.method === "POST") return { id: 4242 + ++repoCount };
      if (_path === "/graphql") return { data: {} };
      return {};
    },
    async repo(app: { repo: string }, path: string, options: { method?: string; body?: any } = {}) {
      const method = options.method ?? "GET", body = options.body;
      const head = /^\/git\/ref\/heads\/(.+)$/.exec(path);
      if (head) { const id = refs.get(`${app.repo}#refs/heads/${head[1]}`); if (!id) throw notFound(); return { object: { sha: id } }; }
      const cm = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path);
      if (cm) { const c = commits.get(cm[1]); if (!c) throw notFound(); return { sha: cm[1], message: c.message, parents: c.parents.map(sha => ({ sha })), tree: { sha: cm[1] } }; }
      if (path === "/git/blobs") { const id = sha(); blobs.set(id, body.encoding === "base64" ? atob(body.content) : body.content); return { sha: id }; }
      if (path === "/git/trees") {
        const tree: Tree = new Map(commits.get(body.base_tree)!.tree);
        for (const e of body.tree) tree.set(e.path, e.content !== undefined ? { content: e.content, mode: e.mode } : { sha: e.sha, mode: e.mode });
        const id = sha();
        commits.set(id, { message: "tree", parents: [], tree });
        return { sha: id };
      }
      if (path === "/git/commits" && method === "POST") return { sha: commit(app.repo, body.message, body.parents, commits.get(body.tree)!.tree) };
      if (path === "/git/refs" && method === "POST") { refs.set(`${app.repo}#${body.ref}`, body.sha); return {}; }
      if (path.startsWith("/pulls?")) return [];
      if (path === "/pulls" && method === "POST") {
        const number = pulls.length + 1;
        pulls.push({ repo: app.repo, number, head: body.head, title: body.title });
        return { number, html_url: `https://github.com/${app.repo}/pull/${number}`, head: { sha: refs.get(`${app.repo}#refs/heads/${body.head}`) }, node_id: `PR_${number}` };
      }
      return {};
    },
    async configureAccess(app: { repo: string }) { refs.has(mainKey(app.repo)) || this.seed(app.repo); },
  };
}

function kvStore() {
  const data = new Map<string, unknown>();
  return {
    get: <T,>(k: string) => (data.has(k) ? (k === "callback" ? data.get(k) : structuredClone(data.get(k))) as T : undefined),
    put: (k: string, v: unknown) => { data.set(k, k === "callback" || typeof v !== "object" || v === null ? v : structuredClone(v)); },
    delete: (k: string) => data.delete(k),
  };
}

function materialize(github: ReturnType<typeof fakeGithub>, repo: string, branch: string, target: string) {
  const id = github.refs.get(`${repo}#refs/heads/${branch}`)!;
  rmSync(target, { recursive: true, force: true });
  for (const [path, file] of github.commits.get(id)!.tree) {
    const full = join(target, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content ?? Buffer.from(github.blobs.get(file.sha!) ?? "", "binary"), { mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
  return github.commits.get(id)!.tree.size;
}

const originalFetch = globalThis.fetch;

describe.skipIf(!enabled)("local end-to-end: Gatekeeper -> gateway -> rendered app", () => {
  afterAll(() => { (globalThis as { fetch: unknown }).fetch = originalFetch; });

  it("creates and imports apps through one approval each and writes the branch trees to disk", async () => {
    const dir = (name: string) => pathToFileURL(join(gatewayDir!, name)).href;
    const { database, user } = await import(/* @vite-ignore */ dir("tests/db.mjs"));
    const { api } = await import(/* @vite-ignore */ dir("src/platform.mjs"));
    const { GitHub } = await import(/* @vite-ignore */ dir("src/github.mjs"));

    const tar = execFileSync("git", ["archive", "--format=tar.gz", "--prefix=nextgendots-ng-dots-boilerplate-c3991a4/", "HEAD"], { cwd: boilerplateDir, maxBuffer: 1 << 28 });
    const github = fakeGithub();
    Object.assign(GitHub.prototype, {
      call: (path: string, options: object) => github.call(path, options),
      repo(app: { repo: string }, path: string, options: object) { return github.repo(app, path, options); },
      configureAccess: (app: { repo: string }) => github.configureAccess(app),
      platformArchive: async () => new Response(tar),
    });

    const DB = database();
    const me = await user(DB, { id: "tenant:me", email: "me@example.com", units: ["demo"] });
    await DB.prepare("UPDATE users SET github_id=?, github_login=? WHERE id=?").bind("1", "me-gh", me.id).run();
    Object.assign(me, { github_id: "1", github_login: "me-gh" });
    const env = { DB, GITHUB_ORG: ORG, BOILERPLATE_REF: REF, WORKFLOWS_REF: "a".repeat(40), BU_SETTINGS_JSON: JSON.stringify({ demo: { accessTeamDomain: "tenant.cloudflareaccess.com", accessAud: "aud-demo", appsUrl: "https://demo.example.com" } }) };

    vi_stub_fetch(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/gateway/plugin", "");
      const request = new Request(url, { method: init?.method ?? "GET" });
      return api(request, env, me, path, init?.body ? JSON.parse(String(init.body)) : {});
    });

    // --- Cloudflare OS side, wired with in-memory Durable Object storage.
    const accounts = new Map<string, NgDotsUserAccount>();
    let counter = 0;
    const exportsObj: any = {
      NgDotsUserAccount: {
        newUniqueId: () => { const id = (++counter).toString(16).padStart(64, "0"); return { toString: () => id }; },
        idFromString: (id: string) => ({ toString: () => id }),
        get: (id: { toString(): string }) => {
          const key = id.toString();
          if (!accounts.has(key)) accounts.set(key, new NgDotsUserAccount({ id: { toString: () => key }, exports: exportsObj, storage: { kv: kvStore(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } } as never, envOs));
          return accounts.get(key)!;
        },
      },
      NgDotsUser: ({ props }: { props: { userObjectId: string } }) => new NgDotsUser({ exports: exportsObj, props } as never, envOs),
    };
    const envOs = { BASE_URL, GATEWAY_URL: GATEWAY } as never;
    const vendor = new GatekeeperVendor({ exports: exportsObj } as never, envOs);
    const { url } = await vendor.connectAccount({ complete: async () => ({}), credentialsExpired: async () => {}, reconnectComplete: async () => ({}) } as never);
    const userObjectId = url.slice(BASE_URL.length).split("/")[1];
    (exportsObj.NgDotsUserAccount.get({ toString: () => userObjectId }) as NgDotsUserAccount).saveCredentials({ accessToken: "local", refreshToken: "local", expiresAt: Date.now() + 3_600_000 });

    const gatekeeper = new NgDotsGatekeeper({ exports: exportsObj, props: { userObjectId }, storage: { kv: kvStore() } } as never, envOs);
    const approvals: Array<{ title: string; description: string }> = [];
    const queue: any = { authorizeObservation: async () => {}, submitAction: async (_id: number, a: { title: string; description: string }) => { approvals.push(a); }, dup() { return queue; } };
    const session = new NgDotsSession(gatekeeper, queue);

    // --- create
    const created = await session.createVibeApp({ businessUnit: "demo", slug: "hello-app", name: "Hello App" });
    expect(github.pulls).toHaveLength(0);
    await gatekeeper.applyAction(created.approvalId);
    const createdStatus = await session.getVibeAppOperation(created.approvalId) as any;
    const createFiles = materialize(github, `${ORG}/demo-hello-app`, createdStatus.branch, join(outDir!, "create"));

    // --- import (a static site)
    const imported = await session.importVibeApp({
      businessUnit: "demo", slug: "site", name: "Site",
      files: [{ path: "index.html", contentBase64: b64("<h1>Hi</h1>") }, { path: "style.css", contentBase64: b64("h1{color:red}") }, { path: "node_modules/x/i.js", contentBase64: b64("x") }],
    });
    await gatekeeper.applyAction(imported.approvalId);
    const importedStatus = await session.getVibeAppOperation(imported.approvalId) as any;
    const importFiles = materialize(github, `${ORG}/demo-site`, importedStatus.branch, join(outDir!, "import"));

    console.log(JSON.stringify({ approvals: approvals.map(a => a.title), createdStatus, importedStatus, createFiles, importFiles, pulls: github.pulls }, null, 2));
    console.log("\n--- create approval text ---\n" + approvals[0].description + "\n\n--- import approval text ---\n" + approvals[1].description);

    expect(createdStatus.state).toBe("completed");
    expect(importedStatus.state).toBe("completed");
    expect(importedStatus.stages.sourceBranchCreated.dropped).toBe(1);
    expect(github.pulls.map(p => p.repo)).toEqual([`${ORG}/demo-hello-app`, `${ORG}/demo-site`]);
    DB.close();
  }, 60_000);
});

function vi_stub_fetch(handler: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  (globalThis as { fetch: unknown }).fetch = handler;
}
