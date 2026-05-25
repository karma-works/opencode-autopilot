import { Tier, type Classification } from "./tier.ts";
import { isAllowedNetworkHost, isLocalhost, isProtectedPath, isWithinReadableBoundary, isWithinWritableRoots } from "../trust/boundary.ts";
import type { TrustBoundary } from "../trust/types.ts";

const readTools = new Set(["read", "grep", "glob", "list"]);
const writeTools = new Set(["write", "edit", "patch"]);

function getStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function classifyWebfetch(args: Record<string, unknown>, boundary: TrustBoundary): Classification {
  const urlText = getStringArg(args, ["url", "uri"]);
  const methodValue = getStringArg(args, ["method"]) ?? "GET";
  const method = methodValue.toUpperCase();
  if (!urlText) return { tier: Tier.T3, reason: "webfetch target URL is missing" };

  try {
    const url = new URL(urlText);
    if (method !== "GET") return { tier: Tier.T3, reason: `webfetch ${method} may mutate remote state` };
    if (isLocalhost(url.hostname)) return { tier: Tier.T2, reason: "localhost GET is inside the local trust boundary" };
    if (isAllowedNetworkHost(url.hostname, boundary)) return { tier: Tier.T1, reason: "GET host is explicitly allowed" };
    return { tier: Tier.T3, reason: "GET host is outside allowedNetworkHosts" };
  } catch {
    return { tier: Tier.T3, reason: "webfetch URL is invalid" };
  }
}

export function classifyToolCall(tool: string, args: Record<string, unknown>, boundary: TrustBoundary): Classification {
  const normalizedTool = tool.toLowerCase();
  if (normalizedTool === "bash") return { tier: Tier.T3, reason: "bash is arbitrary code and always requires judge evaluation" };
  if (normalizedTool === "todowrite") return { tier: Tier.T2, reason: "todo updates are reversible local agent state" };
  if (normalizedTool === "webfetch") return classifyWebfetch(args, boundary);

  if (readTools.has(normalizedTool)) {
    const path = getStringArg(args, ["path", "file", "directory", "dir"]);
    if (!path) return { tier: Tier.T1, reason: "read-only structured tool without a filesystem target" };
    return isWithinReadableBoundary(path, boundary)
      ? { tier: Tier.T1, reason: "read-only target is inside the workspace" }
      : { tier: Tier.T3, reason: "read target is outside the workspace trust boundary" };
  }

  if (writeTools.has(normalizedTool)) {
    const path = getStringArg(args, ["path", "file", "target"]);
    if (!path) return { tier: Tier.T3, reason: "structured write target path is missing" };
    if (isProtectedPath(path, boundary)) return { tier: Tier.T3, reason: "write target is a protected path" };
    if (isWithinWritableRoots(path, boundary)) return { tier: Tier.T2, reason: "structured write target is inside writableRoots" };
    return { tier: Tier.T3, reason: "structured write target is outside writableRoots" };
  }

  return { tier: Tier.T3, reason: "unknown tool requires judge evaluation" };
}
