import { describe, expect, it } from "vitest";
import { inspectImport } from "../src/import-analysis";

describe("inspectImport", () => {
  it("accepts a Vite inventory without mutating it", () => {
    const input = {
      files: [
        { path: "package.json", size: 200 },
        { path: "pnpm-lock.yaml", size: 900 },
        { path: "src/main.tsx", size: 100 },
      ],
      packageJson: { devDependencies: { vite: "^7" } },
    };
    expect(inspectImport(input)).toMatchObject({ framework: "vite", canImport: true, fileCount: 3, totalBytes: 1200 });
  });

  it("fails closed for secrets, symlinks, and traversal", () => {
    const report = inspectImport({
      files: [
        { path: ".env", size: 20 },
        { path: "src/link", kind: "symlink" },
        { path: "../escape.ts" },
        { path: "index.html" },
        { path: "package-lock.json" },
      ],
    });
    expect(report.canImport).toBe(false);
    expect(report.findings.filter(finding => finding.severity === "blocking").map(finding => finding.code))
      .toEqual(expect.arrayContaining(["secret_file", "symlink", "invalid_path"]));
  });

  it("requires review for server code", () => {
    const report = inspectImport({
      files: [{ path: "index.html" }, { path: "server/index.ts" }, { path: "yarn.lock" }],
    });
    expect(report.canImport).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "backend_code", severity: "review" }));
  });

  it("bounds hosted import size", () => {
    const report = inspectImport({
      files: [{ path: "index.html", size: 3 * 1024 * 1024 }, { path: "pnpm-lock.yaml" }],
    });
    expect(report.canImport).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "file_too_large" }));
  });
});
