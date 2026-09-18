import { describe, expect, it } from "vitest";
import { inspectImport } from "../src/import-analysis";

const codes = (report: ReturnType<typeof inspectImport>) => report.findings.filter(f => f.severity === "blocking").map(f => f.code);

describe("inspectImport", () => {
  it("accepts a Vite inventory without mutating it", () => {
    const input = {
      files: [
        { path: "package.json", size: 200 },
        { path: "package-lock.json", size: 900 },
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
      files: [{ path: "index.html" }, { path: "server/index.ts" }],
    });
    expect(report.canImport).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "backend_code", severity: "review" }));
  });

  it("bounds hosted import size", () => {
    const report = inspectImport({
      files: [{ path: "index.html", size: 3 * 1024 * 1024 }],
    });
    expect(report.canImport).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "file_too_large" }));
  });

  it("matches the desktop plugin: npm lockfile, Next.js and duplicate vite configs are blocking", () => {
    expect(codes(inspectImport({ files: [{ path: "package.json" }, { path: "pnpm-lock.yaml" }], packageJson: { devDependencies: { vite: "1" } } }))).toContain("package_lock_required");
    expect(codes(inspectImport({ files: [{ path: "package.json" }], packageJson: { devDependencies: { "react-scripts": "5" } } }))).toContain("package_lock_required");
    expect(codes(inspectImport({ files: [{ path: "package.json" }, { path: "package-lock.json" }], packageJson: { dependencies: { next: "15" } } }))).toContain("next_runtime");
    expect(codes(inspectImport({ files: [{ path: "package.json" }, { path: "package-lock.json" }, { path: "vite.config.ts" }, { path: "vite.config.js" }], packageJson: { devDependencies: { vite: "1" } } }))).toContain("ambiguous_vite_config");
    expect(inspectImport({ files: [{ path: "index.html" }] }).canImport).toBe(true);
  });

  it("blocks paths NG Dots manages", () => {
    const report = inspectImport({ files: [{ path: "index.html" }, { path: ".github/workflows/deploy.yml" }, { path: ".git/config" }] });
    expect(report.findings.filter(f => f.code === "protected_path")).toHaveLength(2);
    expect(report.canImport).toBe(false);
  });
});
