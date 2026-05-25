import { describe, expect, test } from "bun:test";
import { isAllowedNetworkHost, isProtectedPath, isWithinWritableRoots } from "../src/trust/boundary.ts";
import { PROTECTED_PATHS } from "../src/trust/protected-paths.ts";
import type { TrustBoundary } from "../src/trust/types.ts";

const boundary: TrustBoundary = {
  cwd: "/workspace/project",
  writableRoots: ["src", "/workspace/project/test"],
  allowedNetworkHosts: ["api.github.com", "*.example.com"]
};

describe("trust boundary", () => {
  test("normalizes relative and absolute writable roots", () => {
    expect(isWithinWritableRoots("src/app.ts", boundary)).toBe(true);
    expect(isWithinWritableRoots("/workspace/project/test/app.test.ts", boundary)).toBe(true);
    expect(isWithinWritableRoots("README.md", boundary)).toBe(false);
    expect(isWithinWritableRoots("../outside.ts", boundary)).toBe(false);
  });

  test("matches exact and wildcard hosts", () => {
    expect(isAllowedNetworkHost("api.github.com", boundary)).toBe(true);
    expect(isAllowedNetworkHost("docs.example.com", boundary)).toBe(true);
    expect(isAllowedNetworkHost("example.com", boundary)).toBe(false);
  });

  test("flags every protected path entry", () => {
    for (const protectedPath of PROTECTED_PATHS) {
      expect(isProtectedPath(protectedPath, boundary)).toBe(true);
    }
  });
});
