import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const PERSONA_PROFILE_FILENAME = "PROFILE.png";
export const PERSONA_PROFILE_ROUTE_PREFIX = "/api/personas/";

const MAX_PROFILE_BYTES = 8 * 1024 * 1024;
const MIN_PROFILE_DIMENSION = 32;
const MAX_PROFILE_DIMENSION = 4096;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PersonaProfileSource {
  agentId: string;
  personaDir: string;
}

interface PersonaProfileFile {
  filePath: string;
  size: number;
  mtimeMs: number;
}

function inspectPersonaProfile(personaDir: string): PersonaProfileFile | null {
  const filePath = path.resolve(personaDir, PERSONA_PROFILE_FILENAME);
  let descriptor: number | undefined;

  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.size < 24 || stats.size > MAX_PROFILE_BYTES) return null;

    descriptor = fs.openSync(filePath, "r");
    const header = Buffer.alloc(24);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return null;
    if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    if (header.toString("ascii", 12, 16) !== "IHDR") return null;

    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (
      width !== height ||
      width < MIN_PROFILE_DIMENSION ||
      width > MAX_PROFILE_DIMENSION
    ) {
      return null;
    }

    return { filePath, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function personaProfileUrl(agentId: string, personaDir: string): string | null {
  if (!inspectPersonaProfile(personaDir)) return null;
  return `${PERSONA_PROFILE_ROUTE_PREFIX}${encodeURIComponent(agentId)}/profile.png`;
}

function profileNotFound(res: http.ServerResponse): void {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Profile image not found");
}

export function servePersonaProfile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  sources: Iterable<PersonaProfileSource>,
): boolean {
  const match = /^\/api\/personas\/([^/]+)\/profile\.png$/u.exec(url.pathname);
  if (!match) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("Method not allowed");
    return true;
  }

  let agentId: string;
  try {
    agentId = decodeURIComponent(match[1]!);
  } catch {
    profileNotFound(res);
    return true;
  }

  const source = [...sources].find((entry) => entry.agentId === agentId);
  const profile = source ? inspectPersonaProfile(source.personaDir) : null;
  if (!profile) {
    profileNotFound(res);
    return true;
  }

  try {
    const etag = `W/"${profile.size.toString(16)}-${Math.trunc(profile.mtimeMs).toString(16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, {
        ETag: etag,
        "Cache-Control": "private, max-age=3600",
      });
      res.end();
      return true;
    }

    const bytes = req.method === "HEAD" ? undefined : fs.readFileSync(profile.filePath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": profile.size,
      "Cache-Control": "private, max-age=3600",
      "Last-Modified": new Date(profile.mtimeMs).toUTCString(),
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(bytes);
  } catch {
    profileNotFound(res);
  }
  return true;
}
