import { resolve, normalize, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";
import { PROTECTED_PATHS } from "./protected-paths.ts";
import type { TrustBoundary } from "./types.ts";

export function resolveWorkspacePath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

export function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isWithinWritableRoots(path: string, boundary: TrustBoundary): boolean {
  const target = resolveWorkspacePath(path, boundary.cwd);
  return boundary.writableRoots.some((root) => isPathInside(target, resolveWorkspacePath(root, boundary.cwd)));
}

export function isWithinReadableBoundary(path: string, boundary: TrustBoundary): boolean {
  const target = resolveWorkspacePath(path, boundary.cwd);
  return isPathInside(target, resolveWorkspacePath(boundary.cwd, boundary.cwd));
}

export function isProtectedPath(path: string, boundary: TrustBoundary): boolean {
  const target = resolveWorkspacePath(path, boundary.cwd);
  return PROTECTED_PATHS.some((protectedPath) => {
    const root = resolveWorkspacePath(protectedPath, boundary.cwd);
    return isPathInside(target, root);
  });
}

export function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

export function isAllowedNetworkHost(hostname: string, boundary: TrustBoundary): boolean {
  return boundary.allowedNetworkHosts.some((pattern) => hostMatches(hostname, pattern));
}
