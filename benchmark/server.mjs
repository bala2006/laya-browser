/**
 * Local loopback fixture server for the benchmark.
 *
 * Serves benchmark/fixtures/*.html plus a JSON endpoint (/api/data.json) over
 * 127.0.0.1 on an ephemeral port. Using local fixtures (not live sites) keeps the
 * comparison deterministic and fair: no bot-detection, no network latency skew, and
 * identical pages for both servers under test.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Start the fixture server bound to 127.0.0.1 on an ephemeral port.
 * Returns { url, close } where url is the loopback base (no trailing slash).
 */
export async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      let pathname = url.pathname;

      if (pathname === "/api/data.json") {
        const body = JSON.stringify({
          items: [
            { id: 1, name: "alpha" },
            { id: 2, name: "beta" },
            { id: 3, name: "gamma" },
          ],
        });
        res.writeHead(200, { "content-type": CONTENT_TYPES[".json"] });
        res.end(body);
        return;
      }

      if (pathname === "/") pathname = "/search.html";
      // Confine served files to the fixtures directory (no path traversal).
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(FIXTURES_DIR, safe);
      if (!filePath.startsWith(FIXTURES_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const ext = path.extname(filePath);
      const data = await readFile(filePath);
      res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
