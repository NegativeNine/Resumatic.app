import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { AppError, errorCode } from "../shared/errors";
import { allDirectories, vault } from "../shared/stubs";
import { STEP, retrySafely } from "./steps";

export interface FleetCursor {
  directory: number;
  after?: string;
}
export interface FleetReembedParams {
  model: string;
  dimensions: number;
  maxVaults: number;
  cursor?: FleetCursor;
}
export interface FleetResult {
  started: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pendingRuns: { vaultId: string; runId: string }[];
  limited: boolean;
  nextCursor: FleetCursor | null;
}
export interface FleetServices {
  list(
    directory: number,
    after: string | undefined,
    limit: number,
  ): Promise<{ vaultId: string; state: string }[]>;
  start(
    vaultId: string,
    model: string,
    dimensions: number,
    requestKey: string,
  ): Promise<{ runId: string }>;
  status(vaultId: string, runId: string): Promise<{ state: string }>;
}
type Child = {
  vaultId: string;
  runId: string;
  state: "building" | "active" | "failed" | "skipped";
};
const FINAL_ERRORS = new Set([
  "gone",
  "not_found",
  "invalid",
  "conflict",
  "quota",
  "forbidden",
]);

/** Explicit fleet count budget; the per-vault monetary caps still govern every model call. */
export function validateFleetParams(input: FleetReembedParams): void {
  if (
    typeof input.model !== "string" ||
    !input.model.startsWith("@cf/") ||
    input.model.length > 200 ||
    !Number.isSafeInteger(input.dimensions) ||
    input.dimensions < 1 ||
    input.dimensions > 16384 ||
    !Number.isSafeInteger(input.maxVaults) ||
    input.maxVaults < 1 ||
    input.maxVaults > 300
  )
    throw new AppError(
      "invalid",
      "a fleet needs a model, dimensions and a budget of one to three hundred vaults",
    );
  if (
    input.cursor &&
    (!Number.isInteger(input.cursor.directory) ||
      input.cursor.directory < 0 ||
      input.cursor.directory > 16 ||
      (input.cursor.after !== undefined &&
        !/^[a-f0-9]{64}$/i.test(input.cursor.after)))
  )
    throw new AppError("invalid", "invalid fleet continuation cursor");
}

/** All step results contain metadata only. A page starts at most three child workflows. */
export async function runFleet(
  env: Env,
  instanceId: string,
  params: FleetReembedParams,
  step: WorkflowStep,
  services?: FleetServices,
): Promise<FleetResult> {
  validateFleetParams(params);
  const directories = services ? [] : [...allDirectories(env)];
  const api: FleetServices = services ?? {
    list: (index, after, limit) =>
      directories[index]!.listVaults({ after, limit }),
    start: (id, model, dimensions, requestKey) =>
      vault(env, id).startReembed(model, dimensions, requestKey),
    status: (id, runId) => vault(env, id).reembedStatus(runId),
  };
  const result: FleetResult = {
    started: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    pendingRuns: [],
    limited: false,
    nextCursor: null,
  };
  let current = params.cursor ?? { directory: 0 };
  let visited = 0;
  // Even sparse pages stay below 10,000 paid steps: 1,000 lists + 300 x (start + 20 polls).
  for (
    let pageIndex = 0;
    pageIndex < 1000 && current.directory < 17;
    pageIndex++
  ) {
    const key = `${current.directory} ${pageIndex}`;
    const page = await step.do(`list ${key}`, STEP, retrySafely(async () => {
      const limit = Math.min(3, params.maxVaults - visited);
      const rows = await api.list(current.directory, current.after, limit);
      if (
        rows.length > limit ||
        rows.some((row) => !/^[a-f0-9]{64}$/i.test(row.vaultId)) ||
        rows.some(
          (row, index) =>
            row.vaultId <=
            (index === 0 ? (current.after ?? "") : rows[index - 1]!.vaultId),
        )
      )
        throw new Error("invalid_fleet_directory_page");
      return {
        ids: rows
          .filter((row) => row.state === "active")
          .map((row) => row.vaultId),
        after: rows.at(-1)?.vaultId ?? current.after,
        done: rows.length < limit,
      };
    }));
    const next: FleetCursor = page.done
      ? { directory: current.directory + 1 }
      : { directory: current.directory, after: page.after };
    if (page.ids.length) {
      let children: Child[] = await step.do(`start ${key}`, STEP, retrySafely(() =>
        Promise.all(
          page.ids.map(async (vaultId): Promise<Child> => {
            try {
              const { runId } = await api.start(
                vaultId,
                params.model,
                params.dimensions,
                `fleet:${instanceId}:${vaultId}`,
              );
              return { vaultId, runId, state: "building" };
            } catch (error) {
              const code = errorCode(error);
              if (!code || !FINAL_ERRORS.has(code)) throw error;
              return { vaultId, runId: "", state: "skipped" };
            }
          }),
        )),
      );
      visited += children.length;
      result.started += children.filter(
        (child) => child.state !== "skipped",
      ).length;
      for (
        let poll = 0;
        poll < 20 && children.some((child) => child.state === "building");
        poll++
      ) {
        children = await step.do(`poll ${key} ${poll}`, STEP, retrySafely(() =>
          Promise.all(
            children.map(async (child): Promise<Child> => {
              if (child.state !== "building") return child;
              try {
                const status = await api.status(child.vaultId, child.runId);
                if (!["building", "active", "cancelled"].includes(status.state))
                  throw new Error("invalid_fleet_child_state");
                return {
                  ...child,
                  state:
                    status.state === "cancelled"
                      ? "failed"
                      : (status.state as "building" | "active"),
                };
              } catch (error) {
                const code = errorCode(error);
                if (!code || !FINAL_ERRORS.has(code)) throw error;
                return { ...child, state: "failed" };
              }
            }),
          )),
        );
        if (children.some((child) => child.state === "building") && poll < 19)
          await step.sleep(`wait ${key} ${poll}`, "90 seconds");
      }
      result.succeeded += children.filter(
        (child) => child.state === "active",
      ).length;
      result.failed += children.filter(
        (child) => child.state === "failed",
      ).length;
      result.skipped += children.filter(
        (child) => child.state === "skipped",
      ).length;
      result.pendingRuns = children
        .filter((child) => child.state === "building")
        .map(({ vaultId, runId }) => ({ vaultId, runId }));
      if (result.pendingRuns.length)
        return {
          ...result,
          limited: true,
          nextCursor: next.directory < 17 ? next : null,
        };
    }
    current = next;
    if (visited >= params.maxVaults)
      return {
        ...result,
        limited: current.directory < 17,
        nextCursor: current.directory < 17 ? current : null,
      };
  }
  return {
    ...result,
    limited: current.directory < 17,
    nextCursor: current.directory < 17 ? current : null,
  };
}

export class FleetReembedWorkflow extends WorkflowEntrypoint<
  Env,
  FleetReembedParams
> {
  async run(
    event: WorkflowEvent<FleetReembedParams>,
    step: WorkflowStep,
  ): Promise<FleetResult> {
    return runFleet(this.env, event.instanceId, event.payload, step);
  }
}
