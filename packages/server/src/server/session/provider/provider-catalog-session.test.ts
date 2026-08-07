import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  ProviderCatalogSession,
  type ProviderCatalogSessionHost,
} from "./provider-catalog-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { ProviderUsage, SessionOutboundMessage } from "../../messages.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  type ProviderSnapshotManager,
} from "../../agent/provider-snapshot-manager.js";
import type { ProviderSnapshotEntry } from "../../agent/agent-sdk-types.js";
import type { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import { expandProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";

type SnapshotChangeHandler = (entries: ProviderSnapshotEntry[], cwd: string) => void;

interface MakeOptions {
  visibleProviders?: Set<string>;
  supportsCustomModeIcons?: boolean;
  supportsCompactProviderSnapshots?: boolean;
  snapshot?: { [K in keyof ProviderSnapshotManager]?: unknown };
  usage?: { [K in keyof ProviderUsageService]?: unknown };
  host?: Partial<ProviderCatalogSessionHost>;
}

// A codex entry whose two modes exercise both downgrade branches (unknown icon →
// "ShieldCheck", known icon → preserved) plus a claude entry the visibility gate drops.
function makeEntries(): ProviderSnapshotEntry[] {
  return [
    {
      provider: "codex",
      status: "ready",
      enabled: true,
      modes: [
        { id: "default", label: "Default", icon: "Sparkles" },
        { id: "safe", label: "Safe", icon: "ShieldCheck" },
      ],
    },
    { provider: "claude", status: "ready", enabled: true, modes: [] },
  ];
}

function makeCodexUsage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: "pro",
    windows: [
      { id: "session", label: "Session", usedPct: 20 },
      { id: "weekly", label: "Weekly", usedPct: 30 },
      { id: "code_review", label: "Code review", usedPct: 40 },
    ],
    balances: [{ id: "credits", label: "Credits", remaining: 10, unit: "usd" }],
    details: [{ id: "account", label: "Account", value: "dev@example.com" }],
    error: null,
    ...overrides,
  };
}

function makeSubsystem(options: MakeOptions = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const visible = options.visibleProviders ?? new Set(["codex"]);
  let changeHandler: SnapshotChangeHandler | null = null;
  const host: ProviderCatalogSessionHost = {
    emit: (msg) => emitted.push(msg),
    isProviderVisibleToClient: (provider) => visible.has(provider),
    supportsCustomModeIcons: () => options.supportsCustomModeIcons ?? false,
    supportsCompactProviderSnapshots: () => options.supportsCompactProviderSnapshots ?? false,
    listProviderAvailability: async () => [],
    listDraftFeatures: async () => [],
    ...options.host,
  };
  const providerSnapshotManager = createStub<ProviderSnapshotManager>({
    on: (_event: string, handler: SnapshotChangeHandler) => {
      changeHandler = handler;
    },
    off: () => {},
    ...options.snapshot,
  });
  const subsystem = new ProviderCatalogSession({
    host,
    providerSnapshotManager,
    providerUsageService: createStub<ProviderUsageService>(options.usage ?? {}),
    logger: pino({ level: "silent" }),
  });
  function pushSnapshotChange(
    entries: ProviderSnapshotEntry[],
    cwd = GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ): void {
    if (!changeHandler) throw new Error("start() must run before a snapshot change");
    changeHandler(entries, cwd);
  }
  return { subsystem, emitted, pushSnapshotChange };
}

describe("ProviderCatalogSession", () => {
  it("PUSH gates invisible providers and downgrades unknown mode icons for legacy clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries.map((entry) => entry.provider)).toEqual(["codex"]);
    expect(push?.payload.entries[0]?.modes).toEqual([
      { id: "default", label: "Default", icon: "ShieldCheck" },
      { id: "safe", label: "Safe", icon: "ShieldCheck" },
    ]);
  });

  it("PUSH and PULL produce identical visible, downgraded entries for one client", async () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g1",
    });

    const push = findByType(emitted, "providers_snapshot_update");
    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries).toEqual(push?.payload.entries);
  });

  it("returns the canonical cwd used by snapshot updates", async () => {
    const getSnapshot = vi.fn((_cwd?: string) => makeEntries());
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "canonical-cwd",
      cwd: "/repo/./sdk",
    });

    const canonicalCwd = getSnapshot.mock.calls[0]?.[0];
    expect(canonicalCwd).toEqual(expect.any(String));
    expect(findByType(emitted, "get_providers_snapshot_response")?.payload.cwd).toBe(canonicalCwd);
  });

  it("pushes the compact encoding to capable clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      supportsCustomModeIcons: true,
      supportsCompactProviderSnapshots: true,
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries).toEqual([]);
    expect(push?.payload.snapshotHash).toEqual(expect.any(String));
    expect(expandProviderSnapshot(push!.payload.compactSnapshot!)).toEqual([makeEntries()[0]]);
  });

  it("preserves custom mode icons when the client supports them", async () => {
    const { subsystem, emitted } = makeSubsystem({
      supportsCustomModeIcons: true,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g2",
    });

    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries[0]?.modes?.[0]?.icon).toBe("Sparkles");
  });

  it("sends capable clients a compact snapshot and returns not-modified for its hash", async () => {
    const thinkingOptions = [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ];
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: ["one", "two"].map((id) => ({
          provider: "codex",
          id,
          label: id,
          thinkingOptions,
          defaultThinkingOptionId: "high",
        })),
      },
    ];
    const { subsystem, emitted } = makeSubsystem({
      supportsCompactProviderSnapshots: true,
      snapshot: { getSnapshot: () => entries },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-1",
    });

    const first = findByType(emitted, "get_providers_snapshot_response");
    expect(first?.payload.entries).toEqual([]);
    expect(first?.payload.snapshotHash).toEqual(expect.any(String));
    expect(first?.payload.compactSnapshot?.thinkingSets).toHaveLength(1);
    expect(expandProviderSnapshot(first!.payload.compactSnapshot!)).toEqual(entries);

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-2",
      ifNoneMatch: first?.payload.snapshotHash,
    });

    const responses = emitted.filter(
      (message) => message.type === "get_providers_snapshot_response",
    );
    const second = responses[1];
    expect(second?.payload).toMatchObject({
      entries: [],
      snapshotHash: first?.payload.snapshotHash,
      notModified: true,
      requestId: "compact-2",
    });
    expect(second?.payload.compactSnapshot).toBeUndefined();
  });

  it("reports a disabled provider on list_provider_models without warming the snapshot", async () => {
    // warmUpSnapshotForCwd is intentionally unstubbed: createStub throws if it is called,
    // so the disabled short-circuit is proven by the absence of a throw.
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot: () => [{ provider: "codex", status: "loading", enabled: false }] },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m1",
    });

    const res = findByType(emitted, "list_provider_models_response");
    expect(res?.payload.error).toBe("Provider codex is disabled");
  });

  it("hides compatibility-only entries from list_provider_models", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getSnapshot: () => [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            models: [
              { provider: "codex", id: "gpt-5.4", label: "GPT 5.4" },
              {
                provider: "codex",
                id: "gpt-5.4-legacy",
                label: "GPT 5.4 legacy",
                isSelectable: false,
              },
            ],
          },
        ],
      },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-selectable",
    });

    const response = findByType(emitted, "list_provider_models_response");
    expect(response?.payload.models?.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });

  it("preserves missing cwd as the semantic global snapshot for model list reads", async () => {
    const getSnapshot = vi.fn(() => [{ provider: "codex", status: "loading", enabled: true }]);
    const warmUpSnapshotForCwd = vi.fn(async () => {});
    const { subsystem } = makeSubsystem({
      snapshot: { getSnapshot, warmUpSnapshotForCwd },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-global",
    });

    expect(getSnapshot).toHaveBeenCalledWith(undefined);
    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: undefined,
      providers: ["codex"],
    });
  });

  it("surfaces a usage-list failure as an rpc_error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem({
      usage: {
        listUsage: async () => {
          throw new Error("quota service down");
        },
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u1",
    });

    const err = findByType(emitted, "rpc_error");
    expect(err?.payload.code).toBe("provider_usage_list_failed");
    expect(err?.payload.requestId).toBe("u1");
  });

  it("projects configured quota usage once with only session and weekly windows", async () => {
    const codexUsage = makeCodexUsage({ displayName: "Codex Pro" });
    const listUsage = vi.fn(async () => ({
      fetchedAt: "2026-08-07T00:00:00.000Z",
      providers: [codexUsage],
    }));
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        listRegisteredProviderIds: () => ["codex", "cx"],
        getProviderParams: (provider: string) =>
          provider === "cx" ? { usage: { quotaProvider: "codex" } } : undefined,
        getProviderLabel: (provider: string) => (provider === "cx" ? "Claude CX" : "Codex"),
      },
      usage: { listUsage },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u-projection",
    });

    expect(listUsage).toHaveBeenCalledTimes(1);
    const response = findByType(emitted, "provider.usage.list.response");
    expect(response?.payload.providers[0]).toBe(codexUsage);
    expect(response?.payload.providers[1]).toEqual({
      providerId: "cx",
      displayName: "Claude CX",
      status: "available",
      planLabel: "pro",
      sourceLabel: "Codex quota",
      fetchedAt: undefined,
      nextRefreshAt: undefined,
      windows: [
        { id: "session", label: "Session", usedPct: 20 },
        { id: "weekly", label: "Weekly", usedPct: 30 },
      ],
      error: null,
    });
    expect(response?.payload.providers[1]).not.toHaveProperty("balances");
    expect(response?.payload.providers[1]).not.toHaveProperty("details");
  });

  it("projects the exact quota provider error under the custom provider", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        listRegisteredProviderIds: () => ["cx"],
        getProviderParams: () => ({ usage: { quotaProvider: "codex" } }),
        getProviderLabel: () => "Claude CX",
      },
      usage: {
        listUsage: async () => ({
          fetchedAt: "2026-08-07T00:00:00.000Z",
          providers: [
            makeCodexUsage({ status: "error", windows: [], error: "Codex quota failed" }),
          ],
        }),
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u-error",
    });

    const response = findByType(emitted, "provider.usage.list.response");
    expect(response?.payload.providers[1]).toMatchObject({
      providerId: "cx",
      displayName: "Claude CX",
      status: "error",
      sourceLabel: "Codex quota",
      windows: [],
      error: "Codex quota failed",
    });
  });

  it("rejects unsupported quota provider aliases", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        listRegisteredProviderIds: () => ["cx"],
        getProviderParams: () => ({ usage: { quotaProvider: "codex-alias" } }),
        getProviderLabel: () => "Claude CX",
      },
      usage: {
        listUsage: async () => ({
          fetchedAt: "2026-08-07T00:00:00.000Z",
          providers: [makeCodexUsage()],
        }),
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u-no-alias",
    });

    expect(findByType(emitted, "provider.usage.list.response")).toBeUndefined();
    expect(findByType(emitted, "rpc_error")?.payload).toMatchObject({
      requestId: "u-no-alias",
      requestType: "provider.usage.list.request",
      code: "provider_usage_list_failed",
    });
  });

  it("reads quota projection params again after config reload", async () => {
    let providerParams: unknown;
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        listRegisteredProviderIds: () => ["cx"],
        getProviderParams: () => providerParams,
        getProviderLabel: () => "Claude CX",
      },
      usage: {
        listUsage: async () => ({
          fetchedAt: "2026-08-07T00:00:00.000Z",
          providers: [makeCodexUsage()],
        }),
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u-before-reload",
    });
    providerParams = { usage: { quotaProvider: "codex" } };
    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u-after-reload",
    });

    const responses = emitted.filter(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "provider.usage.list.response" }> =>
        message.type === "provider.usage.list.response",
    );
    expect(responses[0]?.payload.providers.map((provider) => provider.providerId)).toEqual([
      "codex",
    ]);
    expect(responses[1]?.payload.providers.map((provider) => provider.providerId)).toEqual([
      "codex",
      "cx",
    ]);
  });

  it("surfaces a feature-list failure inline, not as an rpc_error", async () => {
    const { subsystem, emitted } = makeSubsystem({
      host: {
        listDraftFeatures: async () => {
          throw new Error("feature probe failed");
        },
      },
    });

    await subsystem.handleListProviderFeaturesRequest({
      type: "list_provider_features_request",
      requestId: "f1",
      draftConfig: { provider: "codex", cwd: "/tmp/project" },
    });

    expect(findByType(emitted, "rpc_error")).toBeUndefined();
    const res = findByType(emitted, "list_provider_features_response");
    expect(res?.payload.error).toBe("feature probe failed");
    expect(res?.payload.requestId).toBe("f1");
  });
});
