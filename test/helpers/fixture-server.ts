/**
 * A tiny in-process static file server for the HTML fixtures under `test/fixtures/`.
 *
 * Serving over http (rather than `file://`) keeps navigation, form behaviour, and
 * `window.location` semantics realistic and identical to how a real client would drive
 * the browser, while staying fully offline (loopback only, no network, no weights).
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = normalize(join(here, "..", "fixtures"));

/** A running fixture server with its base URL and a stop function. */
export interface FixtureServer {
  baseUrl: string;
  url(path: string): string;
  close(): Promise<void>;
}

/** Start a loopback http server that serves files from `test/fixtures/`. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer(async (req, res) => {
    try {
      const rawPath = (req.url ?? "/").split("?")[0]!;
      const rel = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
      const filePath = normalize(join(fixturesDir, rel));
      // Guard against path traversal outside the fixtures dir.
      if (!filePath.startsWith(fixturesDir)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      const body = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    url: (path: string) => `${baseUrl}/${path.replace(/^\/+/, "")}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
