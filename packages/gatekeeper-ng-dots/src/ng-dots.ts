import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
  type ActionKind,
  type ApprovalQueue,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  exchangeNgDotsCode,
  NgDotsGatewayClient,
  type NgDotsCredentialStore,
  type NgDotsCredentials,
} from "./client";
import { inspectImport, type ImportFinding, type ImportReport, type ImportRequest } from "./import-analysis";
import {
  approvalText,
  discardSource,
  newBranch,
  operationKey,
  operationStatus,
  runOperation,
  storeSource,
  type OperationKind,
  type VibeAppOperation,
} from "./operations";
import { prepareSource, validateIdentity, type VibeAppInput } from "./source";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  GATEWAY_URL?: string;
};

type UserProps = { userObjectId: string };
type GatekeeperProps = UserProps;
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  verifier?: string;
  reconnect?: true;
};
const NONCE_BYTES = 32;
const FLOW_TTL_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
const LOGO = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%230f172a'/><circle cx='20' cy='32' r='7' fill='%2360a5fa'/><circle cx='32' cy='20' r='7' fill='%23a78bfa'/><circle cx='44' cy='32' r='7' fill='%2334d399'/><circle cx='32' cy='44' r='7' fill='%23fbbf24'/></svg>",
  ),
};

function requireConfig(env: Env): { baseUrl: string; gatewayUrl: string } {
  if (!env.BASE_URL || !env.GATEWAY_URL) throw new Error("NG Dots Gatekeeper is not configured.");
  return {
    baseUrl: env.BASE_URL.replace(/\/$/, ""),
    gatewayUrl: env.GATEWAY_URL.replace(/\/$/, ""),
  };
}

function getBasePath(env: Env): string {
  const path = new URL(requireConfig(env).baseUrl).pathname;
  return path === "/" ? "" : path;
}

function randomBase64Url(bytes = NONCE_BYTES): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const value of new Uint8Array(digest)) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      return new Response("Not Found", { status: 404 });
    }
    const relative = url.pathname.slice(basePath.length);
    const segments = relative.slice(1).split("/");

    if (segments.length === 2 && segments[0].length === 64 && segments[1].length === 43) {
      const account = ctx.exports.NgDotsUserAccount.get(
        ctx.exports.NgDotsUserAccount.idFromString(segments[0]),
      );
      const begun = await account.beginOAuthFlow(segments[1]);
      if (!begun) return new Response("This authorization link is invalid or expired.", { status: 400 });
      const config = requireConfig(env);
      const target = new URL(`${config.gatewayUrl}/auth/login`);
      target.searchParams.set("challenge", begun.challenge);
      target.searchParams.set("return_url", `${config.baseUrl}/oauth/${segments[0]}/${begun.oauthNonce}`);
      return Response.redirect(target.toString(), 302);
    }

    if (segments.length === 3 && segments[0] === "oauth" &&
        segments[1].length === 64 && segments[2].length === 43) {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Malformed NG Dots authorization callback.", { status: 400 });
      const account = ctx.exports.NgDotsUserAccount.get(
        ctx.exports.NgDotsUserAccount.idFromString(segments[1]),
      );
      const handoff = await account.acceptAuthCode(code, segments[2]);
      if (!handoff) return new Response("This authorization callback is invalid or expired.", { status: 400 });
      return htmlResponse(connectHandoffPageHtml(handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "NG Dots",
      url: "https://ngdots.com",
      logo: LOGO,
      color: "#60a5fa",
      tagline: "Build governed VibeApps with the Cloudflare OS agent",
      description: "Connect NG Dots so the built-in agent can plan, create, import, and manage VibeApps without a separate desktop harness.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const id = this.ctx.exports.NgDotsUserAccount.newUniqueId();
    const nonce = randomBase64Url();
    await this.ctx.exports.NgDotsUserAccount.get(id).setCallback(callback, nonce);
    return { url: `${requireConfig(this.env).baseUrl}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export class NgDotsUserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + FLOW_TTL_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + FLOW_TTL_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; challenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) return null;
    const oauthNonce = randomBase64Url();
    const verifier = randomBase64Url();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      verifier,
      expiresAt: Date.now() + FLOW_TTL_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    return { oauthNonce, challenge: await pkceChallenge(verifier) };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) return null;
    this.ctx.storage.kv.delete("nonce");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Authorization took too long. Please reconnect NG Dots.");
    const credentials = await exchangeNgDotsCode(requireConfig(this.env).gatewayUrl, code, stored.verifier);
    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      const stageId = stageCredentials(this.ctx.storage.kv, credentials, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.saveCredentials(credentials);
      try {
        handoff = await callback.complete(this.ctx.exports.NgDotsUser({ props: { userObjectId: this.ctx.id.toString() } }));
      } catch (error) {
        this.ctx.storage.kv.delete("accessToken");
        this.ctx.storage.kv.delete("refreshToken");
        this.ctx.storage.kv.delete("expiresAt");
        throw error;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  async loadCredentials(): Promise<NgDotsCredentials> {
    const accessToken = this.ctx.storage.kv.get<string>("accessToken");
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    const expiresAt = this.ctx.storage.kv.get<number>("expiresAt");
    if (!accessToken || !refreshToken || !expiresAt) throw new Error("NG Dots credentials are unavailable. Please reconnect.");
    return { accessToken, refreshToken, expiresAt };
  }

  saveCredentials(credentials: NgDotsCredentials): void {
    this.ctx.storage.kv.put("accessToken", credentials.accessToken);
    this.ctx.storage.kv.put("refreshToken", credentials.refreshToken);
    this.ctx.storage.kv.put("expiresAt", credentials.expiresAt);
    this.ctx.storage.kv.put("expiredNotified", false);
  }

  async commitReconnect(stageId: string): Promise<void> {
    const credentials = commitStagedCredentials<NgDotsCredentials>(this.ctx.storage.kv, Date.now(), stageId);
    if (!credentials) throw new Error("No NG Dots reconnect is awaiting confirmation.");
    this.saveCredentials(credentials);
  }

  async noteExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    await this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback")?.credentialsExpired();
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) await this.ctx.storage.deleteAll();
  }
}

function credentialStore(account: DurableObjectStub<NgDotsUserAccount>): NgDotsCredentialStore {
  return {
    load: () => account.loadCredentials(),
    save: credentials => account.saveCredentials(credentials),
    expired: () => account.noteExpired(),
  };
}

@validateRpc()
export class NgDotsUser extends WorkerEntrypoint<Env, UserProps> implements GatekeeperUser {
  #account(): DurableObjectStub<NgDotsUserAccount> {
    return this.ctx.exports.NgDotsUserAccount.get(
      this.ctx.exports.NgDotsUserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  #client(): NgDotsGatewayClient {
    return new NgDotsGatewayClient(requireConfig(this.env).gatewayUrl, credentialStore(this.#account()));
  }

  async describe(): Promise<AccountDescription> {
    const me = await this.#client().call<{ email?: string }>("/api/me");
    return {
      displayName: me.email ?? "NG Dots account",
      uniqueName: me.email,
      avatar: LOGO,
      singleton: { tsType: "NgDotsSession" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    const me = await this.#client().call<{ email?: string }>("/api/me");
    return me.email ?? null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never { throw new Error("NG Dots is exposed as an account singleton."); }
  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("NG Dots has no resource configurator."); }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> { await this.#account().revoke(); }

  async reconnect(): Promise<{ url: string }> {
    const nonce = randomBase64Url();
    await this.#account().prepareReconnect(nonce);
    return { url: `${requireConfig(this.env).baseUrl}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> { await this.#account().commitReconnect(stageId); }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.NgDotsVerifier({});
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<NgDotsSession>>> {
    return this.ctx.exports.NgDotsGatekeeper({ props: { userObjectId: this.ctx.props.userObjectId } });
  }
}

@validateRpc()
export class NgDotsVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class NgDotsSession extends RpcTarget {
  constructor(
    private readonly gatekeeper: NgDotsGatekeeper,
    private readonly queue: RpcStub<ApprovalQueue>,
  ) { super(); }

  [Symbol.dispose](): void { this.queue[Symbol.dispose]?.(); }

  async #observe<T>(title: string, description: string, read: () => Promise<T> | T): Promise<T> {
    const value = await read();
    await this.queue.authorizeObservation({ title, description });
    return value;
  }

  async getIdentity(): Promise<unknown> {
    return this.#observe("Read NG Dots identity", "Read the connected user's NG Dots identity and business-unit access.", () => this.gatekeeper.call("/api/me"));
  }

  async listApps(): Promise<unknown> {
    return this.#observe("List NG Dots apps", "List VibeApps visible to the connected NG Dots account.", () => this.gatekeeper.call("/api/apps"));
  }

  async listModels(): Promise<unknown> {
    return this.#observe("List NG Dots AI models", "List the Workers AI models approved by NG Dots.", () => this.gatekeeper.call("/api/models"));
  }

  async getApp(appId: string): Promise<unknown> {
    if (!/^[a-z][a-z0-9-]{0,19}\/[a-z][a-z0-9-]{0,29}$/.test(appId)) throw new Error("invalid_app_id");
    return this.#observe("Read NG Dots app", `Read governed state for ${appId}.`, () => this.gatekeeper.call(`/api/apps/${appId}`));
  }

  async inspectImport(request: ImportRequest): Promise<ImportReport> {
    return this.#observe("Inspect VibeApp import", "Analyze the provided source inventory for NG Dots import compatibility without changing it.", () => inspectImport(request));
  }

  /** One approval covers repository provisioning, source publication to a new ng-dots branch, and the pull request. */
  async createVibeApp(input: VibeAppInput): Promise<{ approvalId: number }> {
    return this.gatekeeper.submitOperation(this.queue, "createVibeApp", input);
  }

  async importVibeApp(input: VibeAppInput): Promise<{ approvalId: number }> {
    return this.gatekeeper.submitOperation(this.queue, "importVibeApp", input);
  }

  async getVibeAppOperation(approvalId: number): Promise<unknown> {
    return this.#observe("Read VibeApp operation", `Read the staged progress of NG Dots operation ${approvalId}.`, () => this.gatekeeper.operationStatus(approvalId));
  }
}

@validateRpc()
export class NgDotsGatekeeper extends DurableObject<Env, GatekeeperProps> implements Gatekeeper<NgDotsSession> {
  #account(): DurableObjectStub<NgDotsUserAccount> {
    return this.ctx.exports.NgDotsUserAccount.get(
      this.ctx.exports.NgDotsUserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  #client(): NgDotsGatewayClient {
    return new NgDotsGatewayClient(requireConfig(this.env).gatewayUrl, credentialStore(this.#account()));
  }

  async call(path: string, method = "GET", body?: unknown): Promise<unknown> {
    return this.#client().call<unknown>(path, method, body);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "ngdots://account",
      title: "NG Dots",
      snippet: "Plan, inspect, and perform governed VibeApp operations.",
      suggestedBindingName: "NG_DOTS",
      tsType: "NgDotsSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<NgDotsSession> { return new NgDotsSession(this, queue.dup()); }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  #nextId(): number {
    const next = (this.ctx.storage.kv.get<number>("nextActionId") ?? 0) + 1;
    this.ctx.storage.kv.put("nextActionId", next);
    return next;
  }

  async submitOperation(queue: RpcStub<ApprovalQueue>, type: OperationKind, input: VibeAppInput): Promise<{ approvalId: number }> {
    const identity = validateIdentity(input);
    const source = prepareSource(input);
    const approvalId = this.#nextId();
    const verb = type === "createVibeApp" ? "Create" : "Import";
    const operation: VibeAppOperation = {
      type,
      approvalId,
      input: identity,
      branch: newBranch(type),
      title: `${verb} VibeApp ${identity.businessUnit}/${identity.slug}`.slice(0, 160),
      framework: source.report.framework,
      fileCount: source.report.fileCount,
      totalBytes: source.totalBytes,
      reviewedFindingCodes: [...new Set(source.reviewFindings.map((finding: ImportFinding) => finding.code))],
      sourceChunks: storeSource(this.ctx.storage.kv, approvalId, source),
      state: "staged",
      stages: {},
    };
    const key = operationKey(approvalId);
    this.ctx.storage.kv.put(key, operation);
    try {
      await queue.submitAction(approvalId, {
        title: `${verb} VibeApp ${identity.businessUnit}/${identity.slug}`,
        description: approvalText(operation, source.reviewFindings),
        implementsRevert: false,
        awaitDecision: true,
        actionKind: { tag: `ng-dots.${type === "createVibeApp" ? "create" : "import"}-vibe-app`, label: `${verb} VibeApp` },
      });
    } catch (error) {
      discardSource(this.ctx.storage.kv, operation);
      this.ctx.storage.kv.delete(key);
      throw error;
    }
    operation.state = "pending";
    this.ctx.storage.kv.put(key, operation);
    return { approvalId };
  }

  operationStatus(approvalId: number): unknown {
    const operation = this.ctx.storage.kv.get<VibeAppOperation>(operationKey(approvalId));
    if (!operation) throw new Error("Unknown NG Dots operation.");
    return operationStatus(operation);
  }

  async applyAction(actionId: number): Promise<void> {
    const operation = this.ctx.storage.kv.get<VibeAppOperation>(operationKey(actionId));
    if (!operation || (operation.state !== "pending" && operation.state !== "failed" && operation.state !== "running")) {
      throw new Error("NG Dots action is not pending.");
    }
    await runOperation(this.ctx.storage.kv, (path, method, body) => this.call(path, method, body), operation);
  }

  async rejectAction(actionId: number): Promise<void> {
    const operation = this.ctx.storage.kv.get<VibeAppOperation>(operationKey(actionId));
    if (!operation) throw new Error("Unknown NG Dots action.");
    discardSource(this.ctx.storage.kv, operation);
    this.ctx.storage.kv.delete(operationKey(actionId));
  }

  revertAction(_actionId: number): Promise<void> {
    throw new Error("NG Dots VibeApp operations cannot be reverted automatically.");
  }
}
