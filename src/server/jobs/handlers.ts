import type { JobName, JobPayloads } from "./queue";

/** Single job router shared by the worker and inline execution. */
export async function runJob<N extends JobName>(name: N, data: JobPayloads[N]): Promise<unknown> {
  switch (name) {
    case "outbox": {
      const { processOutbox } = await import("@/server/modules/automation/engine");
      return processOutbox((data as JobPayloads["outbox"]).orgId);
    }
    case "import.validate": {
      const d = data as JobPayloads["import.validate"];
      const { runValidation } = await import("@/server/modules/delivery/imports/service");
      return runValidation(d.orgId, d.actorId, d.batchId);
    }
    case "import.commit": {
      const d = data as JobPayloads["import.commit"];
      const { runCommit } = await import("@/server/modules/delivery/imports/service");
      return runCommit(d.orgId, d.actorId, d.batchId);
    }
    case "message.send": {
      const d = data as JobPayloads["message.send"];
      const { sendMessageJob } = await import("@/server/modules/digital/sender");
      return sendMessageJob(d.orgId, d.messageJobId);
    }
    case "campaign.dispatch": {
      const d = data as JobPayloads["campaign.dispatch"];
      const { dispatchCampaign } = await import("@/server/modules/digital/sender");
      return dispatchCampaign(d.orgId, d.actorId, d.campaignId);
    }
    case "scheduler.tick": {
      const { schedulerTick } = await import("@/server/modules/automation/scheduler");
      return schedulerTick();
    }
    default:
      throw new Error(`Unknown job ${String(name)}`);
  }
}
