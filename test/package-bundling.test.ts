import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function buildFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? buildFiles(path)
      : path.endsWith(".mjs") || path.endsWith(".d.mts")
        ? [path]
        : [];
  });
}

function publishedBuildFiles(): string[] {
  return [join(ROOT, "dist"), join(ROOT, "plugin", "scripts")].flatMap(buildFiles);
}

function bundledSdkImports(source: string, fileName = "bundle.mjs"): string[] {
  const imports: string[] = [];
  const addSpecifier = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteral(node)) return;
    if (/^(?:iii-sdk|@iii-dev\/helpers)(?:\/|$)/.test(node.text)) {
      imports.push(node.text);
    }
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".d.mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        addSpecifier(node.arguments[0]);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addSpecifier(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

describe("published package SDK contract", () => {
  it("does not expose iii-sdk as a runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies?.["iii-sdk"]).toBeUndefined();
    expect(pkg.devDependencies?.["iii-sdk"]).toMatch(
      /^git\+https:\/\/github\.com\/Althenia\/iii\.git#[0-9a-f]{40}&path:\/sdk\/packages\/node\/iii$/,
    );
  });

  it("finds SDK imports in code but not comments or strings", () => {
    expect(
      bundledSdkImports('import client from "iii-sdk/default";'),
    ).toEqual(["iii-sdk/default"]);
    expect(
      bundledSdkImports('import { request } from "iii-sdk/named";'),
    ).toEqual(["iii-sdk/named"]);
    expect(bundledSdkImports('import "iii-sdk/side-effect";')).toEqual([
      "iii-sdk/side-effect",
    ]);
    expect(bundledSdkImports('await import("iii-sdk/dynamic");')).toEqual([
      "iii-sdk/dynamic",
    ]);
    expect(bundledSdkImports('const client = require("iii-sdk/require");')).toEqual([
      "iii-sdk/require",
    ]);
    expect(
      bundledSdkImports('import type { Helper } from "@iii-dev/helpers/types";'),
    ).toEqual(["@iii-dev/helpers/types"]);
    expect(
      bundledSdkImports(
        'type Helper = import("iii-sdk/declarations").Helper;',
        "fixture.d.mts",
      ),
    ).toEqual(["iii-sdk/declarations"]);
    expect(
      bundledSdkImports('// import "iii-sdk/comment";\nconst example = "require(\\\"iii-sdk/string\\\")";'),
    ).toEqual([]);
  });

  it("contains no external bundled SDK import", () => {
    for (const file of publishedBuildFiles()) {
      const source = readFileSync(file, "utf8");
      expect(bundledSdkImports(source, file), file).toEqual([]);
    }
  });

  it("does not reinstall the legacy SDK during upgrade", () => {
    const cli = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
    expect(cli).not.toContain("iii-sdk@0.11.2");
    expect(cli).not.toContain("Pinning iii-sdk");
  });
});
