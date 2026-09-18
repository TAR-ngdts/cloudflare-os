import { describe, expect, it } from "vitest";
import { prepareSource, validateIdentity, validateName, type SourceFileInput } from "../src/source";

const b64 = (text: string) => btoa(text);
const filled = (bytes: number, value = 1) => { let out = ""; for (let i = 0; i < bytes; i += 0x8000) out += String.fromCharCode(value).repeat(Math.min(0x8000, bytes - i)); return btoa(out); };
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const file = (path: string, text = "x", mode?: SourceFileInput["mode"]): SourceFileInput => ({ path, contentBase64: b64(text), mode });
const vite = (extra: SourceFileInput[] = []) => [
  file("package.json", JSON.stringify({ devDependencies: { vite: "^7" } })),
  file("package-lock.json", "{}"),
  file("src/main.tsx", "console.log(1)"),
  ...extra,
];
const input = (files: SourceFileInput[], acknowledgedFindingCodes?: string[]) => ({ businessUnit: "demo", slug: "app", files, acknowledgedFindingCodes });

describe("prepareSource", () => {
  it("derives sizes from content and reports the framework", () => {
    const prepared = prepareSource(input(vite()));
    expect(prepared.report).toMatchObject({ framework: "vite", canImport: true, fileCount: 3 });
    expect(prepared.framework).toBe("vite");
    expect(prepared.totalBytes).toBe(byteLength(JSON.stringify({ devDependencies: { vite: "^7" } })) + 2 + 14);
    expect(prepared.files.every(f => f.mode === "100644")).toBe(true);
  });

  it("maps create-react-app to the gateway spelling and rejects npm-lockless or Next.js projects", () => {
    const cra = [file("package.json", JSON.stringify({ dependencies: { "react-scripts": "5" } })), file("package-lock.json", "{}"), file("src/index.js")];
    expect(prepareSource(input(cra)).framework).toBe("cra");
    expect(() => prepareSource(input([file("package.json", JSON.stringify({ devDependencies: { vite: "1" } })), file("pnpm-lock.yaml", "x")]))).toThrow(/package_lock_required/);
    expect(() => prepareSource(input([file("package.json", JSON.stringify({ dependencies: { next: "15" } })), file("package-lock.json", "{}")]))).toThrow(/next_runtime/);
  });

  it("fails closed on blocking findings and cannot be overridden by acknowledgement", () => {
    for (const bad of [".env", "config/server.pem", ".github/workflows/deploy.yml", ".git/config", "../escape.ts", "/abs.ts", "a//b.ts"]) {
      expect(() => prepareSource(input(vite([file(bad)]), ["secret_file", "protected_path", "invalid_path"]))).toThrow(/source_blocked/);
    }
    expect(() => prepareSource(input([file("notes.txt")]))).toThrow(/unsupported_framework/);
  });

  it("allows example env files", () => {
    expect(prepareSource(input(vite([file(".env.example", "KEY=")]))).report.canImport).toBe(true);
  });

  it("requires explicit acknowledgement of every review finding", () => {
    const files = [file("index.html"), file("server/index.ts")];
    expect(() => prepareSource(input(files))).toThrow("review_findings_require_acknowledgement: backend_code");
    expect(() => prepareSource(input(files, ["something_else"]))).toThrow(/backend_code/);
    const prepared = prepareSource(input(files, ["backend_code"]));
    expect(prepared.reviewFindings).toHaveLength(1);
    expect(prepared.framework).toBe("static");
  });

  it("rejects malformed content, modes, duplicates and package.json", () => {
    expect(() => prepareSource(input([file("index.html"), { path: "a", contentBase64: "not base64!" }]))).toThrow("invalid_file_content");
    expect(() => prepareSource(input([{ path: "a", contentBase64: undefined as never }]))).toThrow("invalid_file_content");
    expect(() => prepareSource(input([file("index.html"), file("run", "x", "120000" as never)]))).toThrow("symlinks_and_special_files_rejected");
    expect(() => prepareSource(input([file("index.html"), file("a.txt"), file("A.TXT")]))).toThrow("duplicate_file_path");
    expect(() => prepareSource(input([file("package.json", "{not json")]))).toThrow("package_json_invalid");
    expect(() => prepareSource(input([file("package.json", "[]")]))).toThrow("package_json_invalid");
    expect(() => prepareSource({ businessUnit: "demo", slug: "app" } as never)).toThrow("files_required");
    expect(() => prepareSource(input([]))).toThrow("files_required");
  });

  it("enforces size limits on decoded content", () => {
    const big = filled(2 * 1024 * 1024 + 1);
    expect(() => prepareSource(input(vite([{ path: "big.bin", contentBase64: big }])))).toThrow(/file_too_large/);
    const chunk = filled(2 * 1024 * 1024);
    expect(() => prepareSource(input(vite(Array.from({ length: 5 }, (_, i) => ({ path: `c${i}.bin`, contentBase64: chunk })))))).toThrow(/source_too_large/);
    expect(() => prepareSource(input(Array.from({ length: 2001 }, (_, i) => file(`f${i}.txt`))))).toThrow(/too_many_files/);
  });
});

describe("validateIdentity", () => {
  it("accepts governed identities only", () => {
    expect(validateIdentity({ businessUnit: "demo", slug: "my-app" })).toEqual({ businessUnit: "demo", slug: "my-app" });
    for (const bad of [{ businessUnit: "Demo", slug: "a" }, { businessUnit: "demo", slug: "a/b" }, { businessUnit: "demo", slug: "" }, { businessUnit: "d".repeat(21), slug: "a" }, { businessUnit: "demo", slug: "../x" }]) {
      expect(() => validateIdentity(bad)).toThrow();
    }
  });
});

describe("validateName", () => {
  it("defaults to the slug and rejects blank, long or control-character names", () => {
    expect(validateName(undefined, "my-app")).toBe("my-app");
    expect(validateName("My App", "my-app")).toBe("My App");
    for (const bad of ["", "   ", "x".repeat(81), "a\u0000b", "a\nb"]) expect(() => validateName(bad, "app")).toThrow("invalid_name");
  });
});
