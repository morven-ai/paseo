import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { addDaemonHostOption, addJsonOption } from "../../utils/command-options.js";
import { withOutput } from "../../output/index.js";

interface MaintenancePayload {
  requestId: string;
  acquired: boolean;
  owner: string | null;
  operationId?: string | null;
  blockers: Array<{ kind: string; count: number; detail?: string }>;
}

interface MaintenanceResult extends MaintenancePayload {
  action: "acquire" | "release" | "status";
}

const maintenanceSchema: OutputSchema<MaintenanceResult> = {
  idField: "action",
  columns: [
    { header: "ACTION", field: "action" },
    { header: "ACQUIRED", field: (item) => String(item.acquired) },
    { header: "OWNER", field: (item) => item.owner ?? "-" },
    { header: "OPERATION", field: (item) => item.operationId ?? "-" },
    {
      header: "BLOCKERS",
      field: (item) =>
        item.blockers.length === 0
          ? "-"
          : item.blockers.map((blocker) => `${blocker.kind}=${blocker.count}`).join(", "),
    },
  ],
  serialize: (data) => data,
};

function maintenanceResult(
  action: MaintenanceResult["action"],
  payload: MaintenancePayload,
): SingleResult<MaintenanceResult> {
  return {
    type: "single",
    data: { action, ...payload },
    schema: maintenanceSchema,
  };
}

async function runMaintenanceRequest(
  action: MaintenanceResult["action"],
  operationId: string | undefined,
  options: CommandOptions,
): Promise<SingleResult<MaintenanceResult>> {
  if (action !== "status" && !operationId) {
    throw new Error("--operation-id is required for maintenance acquire and release");
  }

  const client = await connectToDaemon({
    host: typeof options.host === "string" ? options.host : undefined,
  });
  try {
    let payload: MaintenancePayload;
    if (action === "acquire") {
      payload = await client.acquireDaemonMaintenance(operationId as string);
    } else if (action === "release") {
      payload = await client.releaseDaemonMaintenance(operationId as string);
    } else {
      payload = await client.getDaemonMaintenanceStatus();
    }
    return maintenanceResult(action, payload);
  } finally {
    await client.close().catch(() => {});
  }
}

export function maintenanceCommand(): Command {
  const maintenance = new Command("maintenance").description(
    "Control daemon maintenance admission",
  );

  addJsonOption(
    addDaemonHostOption(
      maintenance
        .command("acquire")
        .description("Acquire the daemon maintenance lock")
        .requiredOption("--operation-id <id>", "Controller operation ID"),
    ),
  ).action(
    withOutput(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const options = command.optsWithGlobals() as CommandOptions;
      return runMaintenanceRequest("acquire", options.operationId as string, options);
    }),
  );

  addJsonOption(
    addDaemonHostOption(
      maintenance
        .command("release")
        .description("Release the daemon maintenance lock")
        .requiredOption("--operation-id <id>", "Controller operation ID"),
    ),
  ).action(
    withOutput(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const options = command.optsWithGlobals() as CommandOptions;
      return runMaintenanceRequest("release", options.operationId as string, options);
    }),
  );

  addJsonOption(
    addDaemonHostOption(
      maintenance.command("status").description("Show daemon maintenance status"),
    ),
  ).action(
    withOutput(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const options = command.optsWithGlobals() as CommandOptions;
      return runMaintenanceRequest("status", undefined, options);
    }),
  );

  return maintenance;
}
