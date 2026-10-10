// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import {
  DEFAULT_UI_FEATURE_FLAGS,
  type UiFeatureFlags,
} from "@gadgets/workshop-shared/feature-flags";
import { useAuthenticatedApi } from "./AuthContext";
import { FeatureFlagsProvider, useUiFeatureFlags } from "./FeatureFlagsContext";

vi.mock("./AuthContext", () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESOLVED_FLAGS = {
  "test-flag": true,
} as unknown as UiFeatureFlags;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function api(getUiFeatureFlags: () => Promise<UiFeatureFlags>): RpcStub<AuthenticatedApi> {
  return { getUiFeatureFlags } as unknown as RpcStub<AuthenticatedApi>;
}

describe("FeatureFlagsProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("uses defaults while loading and ignores a stale API response", async () => {
    const first = deferred<UiFeatureFlags>();
    const second = deferred<UiFeatureFlags>();
    let currentApi = api(() => first.promise);
    let current: ReturnType<typeof useUiFeatureFlags> | undefined;

    vi.mocked(useAuthenticatedApi).mockImplementation(
      () => ({ authenticatedApi: currentApi }) as ReturnType<typeof useAuthenticatedApi>,
    );

    function Probe() {
      current = useUiFeatureFlags();
      return null;
    }

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<FeatureFlagsProvider><Probe /></FeatureFlagsProvider>));
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    currentApi = api(() => second.promise);
    await act(async () => root!.render(<FeatureFlagsProvider><Probe /></FeatureFlagsProvider>));
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    await act(async () => { first.resolve(RESOLVED_FLAGS); });
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    await act(async () => { second.resolve(RESOLVED_FLAGS); });
    expect(current).toEqual({
      flags: { ...DEFAULT_UI_FEATURE_FLAGS, ...RESOLVED_FLAGS },
      loading: false,
    });
  });

  // A reconnect replaces the stub for the same account. Falling back to the defaults until it
  // answers would switch every flag-gated surface off and on again, unmounting it mid-blip. Another
  // account's stub, or one whose account is unknown, gets the defaults at once (fail closed).
  async function swap(nextAccount: object | null) {
    const replacement = deferred<UiFeatureFlags>();
    const account = {};
    let currentApi = api(async () => RESOLVED_FLAGS);
    let accountKey: object | null = account;
    let current: ReturnType<typeof useUiFeatureFlags> | undefined;

    vi.mocked(useAuthenticatedApi).mockImplementation(
      () => ({ authenticatedApi: currentApi, accountKey }) as ReturnType<typeof useAuthenticatedApi>,
    );

    function Probe() {
      current = useUiFeatureFlags();
      return null;
    }

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<FeatureFlagsProvider><Probe /></FeatureFlagsProvider>));
    const loaded = { ...DEFAULT_UI_FEATURE_FLAGS, ...RESOLVED_FLAGS };
    expect(current).toEqual({ flags: loaded, loading: false });

    currentApi = api(() => replacement.promise);
    accountKey = nextAccount === SAME ? account : nextAccount;
    await act(async () => root!.render(<FeatureFlagsProvider><Probe /></FeatureFlagsProvider>));
    const during = current;
    await act(async () => { replacement.resolve({} as UiFeatureFlags); });
    return { loaded, during, after: current };
  }
  const SAME = {};

  it("keeps the flags last loaded while a replacement API for the same account reloads them", async () => {
    const { loaded, during, after } = await swap(SAME);
    expect(during).toEqual({ flags: loaded, loading: true });
    expect(after).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: false });
  });

  it.each([
    ["another account", {}],
    ["an unknown account", null],
  ])("falls back to the defaults at once when the replacement API is for %s", async (_, next) => {
    const { during } = await swap(next);
    expect(during).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });
  });
});
