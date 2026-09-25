import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const fixtureFile = new URL("./chat.html", import.meta.url);

export function createFixtureServer() {
  return createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" || (pathname !== "/" && pathname !== "/chat.html")) {
      response.writeHead(404);
      response.end();
      return;
    }

    try {
      const html = await readFile(fixtureFile);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(html);
    } catch {
      response.writeHead(500);
      response.end("Fixture unavailable");
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Fixture chat: http://127.0.0.1:${server.address().port}/`);
  });
}