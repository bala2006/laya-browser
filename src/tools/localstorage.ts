/**
 * `browser_localstorage_*` tools (capability: `storage`): list/get/set/delete/clear the
 * active page's `window.localStorage`. Each export is a self-contained {@link ToolModule}
 * built from the shared {@link ./web_storage} factory and registered separately.
 */
import type { ToolModule } from "./registry.js";
import * as ws from "./web_storage.js";

const defs = ws.definitions("localStorage");

export const list: ToolModule = {
  definition: defs.list,
  inputSchema: ws.listInputSchema,
  makeHandler: ws.makeListHandler("localStorage") as ToolModule["makeHandler"],
};

export const get: ToolModule = {
  definition: defs.get,
  inputSchema: ws.keyInputSchema,
  makeHandler: ws.makeGetHandler("localStorage") as ToolModule["makeHandler"],
};

export const set: ToolModule = {
  definition: defs.set,
  inputSchema: ws.setInputSchema,
  makeHandler: ws.makeSetHandler("localStorage") as ToolModule["makeHandler"],
};

export const del: ToolModule = {
  definition: defs.delete,
  inputSchema: ws.keyInputSchema,
  makeHandler: ws.makeDeleteHandler("localStorage") as ToolModule["makeHandler"],
};

export const clear: ToolModule = {
  definition: defs.clear,
  inputSchema: ws.listInputSchema,
  makeHandler: ws.makeClearHandler("localStorage") as ToolModule["makeHandler"],
};
