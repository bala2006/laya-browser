/**
 * Network route-mocking + connectivity tools (capability: `network`).
 *
 * `browser_route` registers a rule that fulfills (canned response) or aborts requests
 * matching a URL pattern; `browser_route_list` enumerates the active rules;
 * `browser_unroute` removes one by pattern; `browser_network_state_set` toggles the context
 * between online and offline. All Playwright routing lives behind the browser boundary.
 */
import { z } from "zod";
import type { RouteRule } from "../types.js";
import type { ToolModule } from "./registry.js";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

// --- browser_route ---

export const routeInputSchema = {
  url: z
    .string()
    .describe("URL glob pattern to match (e.g. '**/api/**' or a substring/glob)."),
  action: z
    .enum(["fulfill", "abort"])
    .describe("Serve a canned response ('fulfill') or fail the request ('abort')."),
  status: z.number().int().optional().describe("For 'fulfill': response HTTP status (default 200)."),
  body: z.string().optional().describe("For 'fulfill': the response body."),
  contentType: z
    .string()
    .optional()
    .describe("For 'fulfill': the response Content-Type header (e.g. 'application/json')."),
  errorCode: z
    .string()
    .optional()
    .describe("For 'abort': the Playwright error code to fail with (default 'failed')."),
};

type RouteArgs = {
  url: string;
  action: "fulfill" | "abort";
  status?: number;
  body?: string;
  contentType?: string;
  errorCode?: string;
};

export function makeRouteHandler(ctx: ToolContext) {
  return async (args: RouteArgs): Promise<ToolResult> => {
    try {
      const rule: RouteRule = {
        urlPattern: args.url,
        action: args.action,
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.contentType !== undefined
          ? { headers: { "content-type": args.contentType } }
          : {}),
        ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      };
      await ctx.session.route(rule);
      return textResult(`Routing ${args.url} -> ${args.action}.`);
    } catch (err) {
      return textResult(`Failed to route: ${(err as Error).message}`, true);
    }
  };
}

export const routeDefinition = {
  name: "browser_route",
  description:
    "Mock a network request: fulfill matching requests with a canned response, or abort them, by URL pattern.",
  inputSchema: routeInputSchema,
};

// --- browser_route_list ---

export const listInputSchema = {};

export function makeListHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    const rules = ctx.session.listRoutes();
    if (rules.length === 0) return textResult("No active routes.");
    const lines = rules.map((r) => {
      if (r.action === "abort") return `${r.urlPattern} -> abort (${r.errorCode ?? "failed"})`;
      return `${r.urlPattern} -> fulfill ${r.status ?? 200}`;
    });
    return textResult(`Active routes (${rules.length}):\n${lines.join("\n")}`);
  };
}

export const listDefinition = {
  name: "browser_route_list",
  description: "List the active network route-mocking rules.",
  inputSchema: listInputSchema,
};

// --- browser_unroute ---

export const unrouteInputSchema = {
  url: z.string().describe("The URL pattern of the route to remove."),
};

type UnrouteArgs = { url: string };

export function makeUnrouteHandler(ctx: ToolContext) {
  return async (args: UnrouteArgs): Promise<ToolResult> => {
    try {
      const removed = await ctx.session.unroute(args.url);
      return removed
        ? textResult(`Removed route ${args.url}.`)
        : textResult(`No active route for ${args.url}.`);
    } catch (err) {
      return textResult(`Failed to unroute: ${(err as Error).message}`, true);
    }
  };
}

export const unrouteDefinition = {
  name: "browser_unroute",
  description: "Remove a network route-mocking rule by its URL pattern.",
  inputSchema: unrouteInputSchema,
};

// --- browser_network_state_set ---

export const networkStateInputSchema = {
  offline: z.boolean().describe("Set true to simulate offline, false to restore online."),
};

type NetworkStateArgs = { offline: boolean };

export function makeNetworkStateHandler(ctx: ToolContext) {
  return async (args: NetworkStateArgs): Promise<ToolResult> => {
    try {
      await ctx.session.setOffline(args.offline);
      return textResult(args.offline ? "Network set offline." : "Network set online.");
    } catch (err) {
      return textResult(`Failed to set network state: ${(err as Error).message}`, true);
    }
  };
}

export const networkStateDefinition = {
  name: "browser_network_state_set",
  description: "Set the browser network connectivity: offline (true) or online (false).",
  inputSchema: networkStateInputSchema,
};

// --- Registry modules ---

export const routeModule: ToolModule = {
  definition: routeDefinition,
  inputSchema: routeInputSchema,
  makeHandler: makeRouteHandler as ToolModule["makeHandler"],
};

export const listModule: ToolModule = {
  definition: listDefinition,
  inputSchema: listInputSchema,
  makeHandler: makeListHandler as ToolModule["makeHandler"],
};

export const unrouteModule: ToolModule = {
  definition: unrouteDefinition,
  inputSchema: unrouteInputSchema,
  makeHandler: makeUnrouteHandler as ToolModule["makeHandler"],
};

export const networkStateModule: ToolModule = {
  definition: networkStateDefinition,
  inputSchema: networkStateInputSchema,
  makeHandler: makeNetworkStateHandler as ToolModule["makeHandler"],
};
