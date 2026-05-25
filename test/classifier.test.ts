import { describe, expect, test } from "bun:test";
import { classifyToolCall } from "../src/classifier/classify.ts";
import { Tier } from "../src/classifier/tier.ts";
import type { TrustBoundary } from "../src/trust/types.ts";

const boundary: TrustBoundary = {
  cwd: "/workspace/project",
  writableRoots: ["."],
  allowedNetworkHosts: ["api.github.com", "*.example.com"]
};

describe("classifyToolCall", () => {
  test("classifies structured reads inside the workspace as T1", () => {
    expect(classifyToolCall("read", { path: "src/index.ts" }, boundary).tier).toBe(Tier.T1);
    expect(classifyToolCall("grep", { path: "./src" }, boundary).tier).toBe(Tier.T1);
  });

  test("classifies workspace writes as T2", () => {
    expect(classifyToolCall("write", { path: "src/new.ts" }, boundary).tier).toBe(Tier.T2);
    expect(classifyToolCall("edit", { file: "/workspace/project/src/new.ts" }, boundary).tier).toBe(Tier.T2);
  });

  test("classifies protected and escaping writes as T3", () => {
    expect(classifyToolCall("write", { path: ".git/config" }, boundary).tier).toBe(Tier.T3);
    expect(classifyToolCall("patch", { path: "../outside.ts" }, boundary).tier).toBe(Tier.T3);
  });

  test("classifies all bash calls as T3", () => {
    expect(classifyToolCall("bash", { command: "ls" }, boundary).tier).toBe(Tier.T3);
  });

  test("classifies webfetch by method and host", () => {
    expect(classifyToolCall("webfetch", { url: "https://api.github.com/repos", method: "GET" }, boundary).tier).toBe(Tier.T1);
    expect(classifyToolCall("webfetch", { url: "https://docs.example.com", method: "GET" }, boundary).tier).toBe(Tier.T1);
    expect(classifyToolCall("webfetch", { url: "http://localhost:3000/api", method: "GET" }, boundary).tier).toBe(Tier.T2);
    expect(classifyToolCall("webfetch", { url: "https://api.github.com/repos", method: "POST" }, boundary).tier).toBe(Tier.T3);
    expect(classifyToolCall("webfetch", { url: "https://evil.test", method: "GET" }, boundary).tier).toBe(Tier.T3);
  });
});
