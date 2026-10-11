// Stand-in for the `cloudflare:workers` module, which only exists inside workerd, for the
// `unit-node` project (see vitest.config.ts). Only the names the backend's modules import are
// provided, and only so that `import` and `extends` resolve: a test that needs any of them to
// *behave* belongs in a workerd project, and `__tests__/test-projects.ts` keeps it there.

export class DurableObject<E = unknown, P = unknown> {
  readonly ctx: unknown;
  readonly env: E;
  readonly props?: P;
  constructor(ctx: unknown, env: E, props?: P) {
    this.ctx = ctx;
    this.env = env;
    this.props = props;
  }
}

export class WorkerEntrypoint<E = unknown, P = unknown> {
  readonly ctx: unknown;
  readonly env: E;
  readonly props?: P;
  constructor(ctx: unknown, env: E, props?: P) {
    this.ctx = ctx;
    this.env = env;
    this.props = props;
  }
}

// oxlint-disable-next-line typescript/no-extraneous-class -- empty on purpose: only so `extends` resolves
export class RpcTarget {}

export class RpcStub<T> {
  readonly target: T;
  constructor(target: T) {
    this.target = target;
  }
}

export const restore: unique symbol = Symbol("restore");

/** Present so `agent-tracing.ts` loads; a test that opens a span needs workerd. */
export const tracing = {};

export const env: Record<string, unknown> = {};
