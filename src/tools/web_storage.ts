/**
 * Shared factory for the `localStorage` and `sessionStorage` tool families
 * (capability: `storage`). Both stores expose the same five operations (list, get, set,
 * delete, clear) over the same boundary method, differing only in `which`, so the tool
 * definitions and handlers are generated once here and re-exported by the thin
 * `localstorage.ts` / `sessionstorage.ts` modules.
 */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

type Which = "localStorage" | "sessionStorage";

/** The tool-name prefix for a store, e.g. `browser_localstorage`. */
function prefix(which: Which): string {
  return which === "localStorage" ? "browser_localstorage" : "browser_sessionstorage";
}

/** Human-readable store label used in descriptions and messages. */
function label(which: Which): string {
  return which === "localStorage" ? "localStorage" : "sessionStorage";
}

export const listInputSchema = {};

export function makeListHandler(which: Which) {
  return (ctx: ToolContext) =>
    async (): Promise<ToolResult> => {
      try {
        const items = (await ctx.session.webStorage(which, { kind: "list" })) as Record<
          string,
          string
        >;
        const keys = Object.keys(items);
        if (keys.length === 0) return textResult(`${label(which)} is empty.`);
        const lines = keys.map((k) => `${k}=${items[k]}`);
        return textResult(`${label(which)} (${keys.length}):\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(`Failed to list ${label(which)}: ${(err as Error).message}`, true);
      }
    };
}

export const keyInputSchema = {
  key: z.string().describe("The storage key."),
};

type KeyArgs = { key: string };

export function makeGetHandler(which: Which) {
  return (ctx: ToolContext) =>
    async (args: KeyArgs): Promise<ToolResult> => {
      try {
        const value = (await ctx.session.webStorage(which, {
          kind: "get",
          key: args.key,
        })) as string | null;
        if (value === null) return textResult(`No ${label(which)} entry for '${args.key}'.`);
        return textResult(value);
      } catch (err) {
        return textResult(`Failed to get ${label(which)} entry: ${(err as Error).message}`, true);
      }
    };
}

export const setInputSchema = {
  key: z.string().describe("The storage key."),
  value: z.string().describe("The value to store."),
};

type SetArgs = { key: string; value: string };

export function makeSetHandler(which: Which) {
  return (ctx: ToolContext) =>
    async (args: SetArgs): Promise<ToolResult> => {
      try {
        await ctx.session.webStorage(which, { kind: "set", key: args.key, value: args.value });
        return textResult(`Set ${label(which)} ${args.key}=${args.value}.`);
      } catch (err) {
        return textResult(`Failed to set ${label(which)} entry: ${(err as Error).message}`, true);
      }
    };
}

export function makeDeleteHandler(which: Which) {
  return (ctx: ToolContext) =>
    async (args: KeyArgs): Promise<ToolResult> => {
      try {
        await ctx.session.webStorage(which, { kind: "delete", key: args.key });
        return textResult(`Deleted ${label(which)} entry '${args.key}'.`);
      } catch (err) {
        return textResult(
          `Failed to delete ${label(which)} entry: ${(err as Error).message}`,
          true,
        );
      }
    };
}

export function makeClearHandler(which: Which) {
  return (ctx: ToolContext) =>
    async (): Promise<ToolResult> => {
      try {
        await ctx.session.webStorage(which, { kind: "clear" });
        return textResult(`Cleared ${label(which)}.`);
      } catch (err) {
        return textResult(`Failed to clear ${label(which)}: ${(err as Error).message}`, true);
      }
    };
}

/** Build the five tool definitions for a store, matching the registry `ToolModule` shape. */
export function definitions(which: Which) {
  const p = prefix(which);
  const l = label(which);
  return {
    list: {
      name: `${p}_list`,
      description: `List all ${l} entries on the active page.`,
      inputSchema: listInputSchema,
    },
    get: {
      name: `${p}_get`,
      description: `Get a ${l} entry by key on the active page.`,
      inputSchema: keyInputSchema,
    },
    set: {
      name: `${p}_set`,
      description: `Set a ${l} entry (key + value) on the active page.`,
      inputSchema: setInputSchema,
    },
    delete: {
      name: `${p}_delete`,
      description: `Delete a ${l} entry by key on the active page.`,
      inputSchema: keyInputSchema,
    },
    clear: {
      name: `${p}_clear`,
      description: `Clear all ${l} entries on the active page.`,
      inputSchema: listInputSchema,
    },
  };
}
