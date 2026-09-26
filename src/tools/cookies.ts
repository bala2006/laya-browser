/**
 * Cookie storage tools (capability: `storage`): list, get, set, delete, and clear cookies
 * on the shared browser context. Each tool is a distinct definition/handler registered
 * separately, but they share this module because they act on the same boundary surface.
 */
import { z } from "zod";
import type { ToolModule } from "./registry.js";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

/** Render a single cookie as a stable, human-readable line. */
function renderCookie(c: { name: string; value: string; domain?: string; path?: string }): string {
  const scope = [c.domain, c.path].filter(Boolean).join("");
  return `${c.name}=${c.value}${scope ? ` (${scope})` : ""}`;
}

// --- browser_cookie_list ---

export const listInputSchema = {};

export function makeListHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    try {
      const cookies = await ctx.session.listCookies();
      if (cookies.length === 0) return textResult("No cookies set.");
      const lines = cookies.map((c) => renderCookie(c));
      return textResult(`Cookies (${cookies.length}):\n${lines.join("\n")}`);
    } catch (err) {
      return textResult(`Failed to list cookies: ${(err as Error).message}`, true);
    }
  };
}

export const listDefinition = {
  name: "browser_cookie_list",
  description: "List all cookies in the current browser context.",
  inputSchema: listInputSchema,
};

// --- browser_cookie_get ---

export const getInputSchema = {
  name: z.string().describe("The cookie name to look up."),
};

type GetArgs = { name: string };

export function makeGetHandler(ctx: ToolContext) {
  return async (args: GetArgs): Promise<ToolResult> => {
    try {
      const cookies = await ctx.session.listCookies();
      const found = cookies.filter((c) => c.name === args.name);
      if (found.length === 0) return textResult(`No cookie named '${args.name}'.`);
      return textResult(found.map((c) => renderCookie(c)).join("\n"));
    } catch (err) {
      return textResult(`Failed to get cookie: ${(err as Error).message}`, true);
    }
  };
}

export const getDefinition = {
  name: "browser_cookie_get",
  description: "Get the cookie(s) with the given name from the current context.",
  inputSchema: getInputSchema,
};

// --- browser_cookie_set ---

export const setInputSchema = {
  name: z.string().describe("The cookie name."),
  value: z.string().describe("The cookie value."),
  domain: z.string().optional().describe("Cookie domain. Omit to use the active page's URL."),
  path: z.string().optional().describe("Cookie path. Defaults to '/' when a domain is given."),
  expires: z
    .number()
    .optional()
    .describe("Expiry as a Unix timestamp in seconds. Omit for a session cookie."),
  httpOnly: z.boolean().optional().describe("Mark the cookie HttpOnly."),
  secure: z.boolean().optional().describe("Mark the cookie Secure."),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite policy."),
};

type SetArgs = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export function makeSetHandler(ctx: ToolContext) {
  return async (args: SetArgs): Promise<ToolResult> => {
    try {
      // Default the path to "/" when a domain (but no path) is supplied, matching browsers.
      const path = args.path ?? (args.domain !== undefined ? "/" : undefined);
      await ctx.session.setCookie({
        name: args.name,
        value: args.value,
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(args.expires !== undefined ? { expires: args.expires } : {}),
        ...(args.httpOnly !== undefined ? { httpOnly: args.httpOnly } : {}),
        ...(args.secure !== undefined ? { secure: args.secure } : {}),
        ...(args.sameSite !== undefined ? { sameSite: args.sameSite } : {}),
      });
      return textResult(`Set cookie ${args.name}=${args.value}.`);
    } catch (err) {
      return textResult(`Failed to set cookie: ${(err as Error).message}`, true);
    }
  };
}

export const setDefinition = {
  name: "browser_cookie_set",
  description:
    "Set (or overwrite) a cookie in the current context. Omit domain to scope it to the active page.",
  inputSchema: setInputSchema,
};

// --- browser_cookie_delete ---

export const deleteInputSchema = {
  name: z.string().describe("The cookie name to delete."),
};

type DeleteArgs = { name: string };

export function makeDeleteHandler(ctx: ToolContext) {
  return async (args: DeleteArgs): Promise<ToolResult> => {
    try {
      await ctx.session.deleteCookie(args.name);
      return textResult(`Deleted cookie '${args.name}'.`);
    } catch (err) {
      return textResult(`Failed to delete cookie: ${(err as Error).message}`, true);
    }
  };
}

export const deleteDefinition = {
  name: "browser_cookie_delete",
  description: "Delete the cookie(s) with the given name from the current context.",
  inputSchema: deleteInputSchema,
};

// --- browser_cookie_clear ---

export const clearInputSchema = {};

export function makeClearHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    try {
      await ctx.session.clearCookies();
      return textResult("Cleared all cookies.");
    } catch (err) {
      return textResult(`Failed to clear cookies: ${(err as Error).message}`, true);
    }
  };
}

export const clearDefinition = {
  name: "browser_cookie_clear",
  description: "Remove all cookies from the current browser context.",
  inputSchema: clearInputSchema,
};

// --- Registry modules (each a self-contained ToolModule) ---

export const listModule: ToolModule = {
  definition: listDefinition,
  inputSchema: listInputSchema,
  makeHandler: makeListHandler as ToolModule["makeHandler"],
};

export const getModule: ToolModule = {
  definition: getDefinition,
  inputSchema: getInputSchema,
  makeHandler: makeGetHandler as ToolModule["makeHandler"],
};

export const setModule: ToolModule = {
  definition: setDefinition,
  inputSchema: setInputSchema,
  makeHandler: makeSetHandler as ToolModule["makeHandler"],
};

export const deleteModule: ToolModule = {
  definition: deleteDefinition,
  inputSchema: deleteInputSchema,
  makeHandler: makeDeleteHandler as ToolModule["makeHandler"],
};

export const clearModule: ToolModule = {
  definition: clearDefinition,
  inputSchema: clearInputSchema,
  makeHandler: makeClearHandler as ToolModule["makeHandler"],
};
