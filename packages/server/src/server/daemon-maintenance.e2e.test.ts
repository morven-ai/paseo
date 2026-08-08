import os from "node:os";
import { afterEach, expect, test } from "vitest";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const previousBuildId = process.env.PASEO_RUNTIME_BUILD_ID;
const previousMaintenanceOperationId = process.env.PASEO_MAINTENANCE_OPERATION_ID;

afterEach(() => {
  if (previousBuildId === undefined) delete process.env.PASEO_RUNTIME_BUILD_ID;
  else process.env.PASEO_RUNTIME_BUILD_ID = previousBuildId;
  if (previousMaintenanceOperationId === undefined) {
    delete process.env.PASEO_MAINTENANCE_OPERATION_ID;
  } else {
    process.env.PASEO_MAINTENANCE_OPERATION_ID = previousMaintenanceOperationId;
  }
});

test("daemon boots fenced, rejects provider admission, and releases by operation ID", async () => {
  process.env.PASEO_RUNTIME_BUILD_ID = "maintenance-e2e-build";
  process.env.PASEO_MAINTENANCE_OPERATION_ID = "maintenance-e2e-operation";

  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.5",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "maintenance-e2e" } });

    const status = await client.getDaemonStatus();
    expect(status.runtimeBuildId).toBe("maintenance-e2e-build");

    const maintenance = await client.getDaemonMaintenanceStatus();
    expect(maintenance).toMatchObject({
      acquired: true,
      owner: "maintenance-e2e-operation",
      operationId: "maintenance-e2e-operation",
      blockers: [],
    });

    await expect(
      client.createAgent({
        provider: "codex",
        cwd: os.tmpdir(),
        title: "Blocked by maintenance",
      }),
    ).rejects.toThrow("Provider work is blocked by daemon maintenance");

    expect(await client.releaseDaemonMaintenance("maintenance-e2e-operation")).toMatchObject({
      acquired: false,
      owner: null,
    });
    expect(await client.getDaemonMaintenanceStatus()).toMatchObject({
      acquired: false,
      owner: null,
    });
  } finally {
    await client.close();
    await daemon.close();
  }
});
