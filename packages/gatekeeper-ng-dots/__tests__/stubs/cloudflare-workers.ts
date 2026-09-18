/** Minimal stand-ins so the Gatekeeper classes can run under Node; the real runtime supplies these in production. */
export class DurableObject<E = unknown> {
  constructor(readonly ctx: any, readonly env: E) {}
}

export class WorkerEntrypoint<E = unknown> {
  constructor(readonly ctx: any, readonly env: E) {}
}

export class RpcTarget {
  readonly stub = "RpcTarget";
}

export class RpcStub {
  readonly stub = "RpcStub";
}
