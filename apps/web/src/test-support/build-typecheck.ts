import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

/**
 * 本番のビルドの型検査を TypeScript の API で再現するためのテスト支援
 * （052-rebuild-without-tests 設計 §10・実装プラン §2「テストの方法」）。
 *
 * `next build` は `tsc --project <設定> --noEmit` で型検査する（設計 §1.2 の 4）。
 * ここでは同じ設定からプログラムを組み、**ディスクへ書かずに**
 * 「同梱 Plugin のフォルダが無い」「ファイルに型の誤りがある」状態を CompilerHost で見せる。
 *
 * テストからだけ import する（ビルドの設定は `src/test-support` を外す）。
 */

/** `\` を `/` に揃える。TypeScript に渡すパス・比べるパスはすべてこの形にする。 */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** 比較用のキー。大文字小文字を区別しないファイルシステムでは小文字に揃える。 */
export function pathKey(path: string): string {
  const posix = toPosix(path);
  return ts.sys.useCaseSensitiveFileNames ? posix : posix.toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** `path` が `dir` そのものか、その下にあるか。 */
export function isUnder(path: string, dir: string): boolean {
  const p = pathKey(path);
  const d = pathKey(dir).replace(/\/+$/, '');
  return p === d || p.startsWith(`${d}/`);
}

export const REPO_ROOT = toPosix(resolve(import.meta.dirname, '..', '..', '..', '..'));
export const WEB_DIR = `${REPO_ROOT}/apps/web`;
export const WEB_SRC_DIR = `${WEB_DIR}/src`;
export const PLUGINS_DIR = `${REPO_ROOT}/plugins`;
export const REGISTRY_PATH = `${WEB_SRC_DIR}/plugin/generated-registry.ts`;
export const BUILD_CONFIG_PATH = `${WEB_DIR}/tsconfig.build.json`;
export const CHECK_CONFIG_PATH = `${WEB_DIR}/tsconfig.json`;
const GENERATOR_PATH = `${REPO_ROOT}/scripts/generate-plugin-registry.mjs`;

/** 「F に型の誤りを足す」ときに末尾へ足す文（設計 §10 の定義）。 */
export const INJECTED_ERROR = "\nexport const __guard052: number = 'x';\n";

export type ConfigKind = 'build' | 'check';

function configPath(kind: ConfigKind): string {
  return kind === 'build' ? BUILD_CONFIG_PATH : CHECK_CONFIG_PATH;
}

function describeDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      const file = d.file === undefined ? '' : `${toPosix(d.file.fileName)}: `;
      return `${file}TS${d.code} ${message}`;
    })
    .join('\n');
}

/**
 * 設定を継承を解いて読む（設計 §10 の「ビルドの設定」「検査の設定」）。
 * 読めなければ、**何が読めないか**を言う文で落とす。
 */
export function readParsedConfig(kind: ConfigKind): ts.ParsedCommandLine {
  const path = configPath(kind);
  if (!existsSync(path)) {
    throw new Error(`型検査の設定が無い: ${path}`);
  }
  const unrecoverable: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        unrecoverable.push(diagnostic);
      },
    },
  );
  if (parsed === undefined || unrecoverable.length > 0) {
    throw new Error(`型検査の設定を読めない: ${path}\n${describeDiagnostics(unrecoverable)}`);
  }
  if (parsed.errors.length > 0) {
    throw new Error(`型検査の設定に誤りがある: ${path}\n${describeDiagnostics(parsed.errors)}`);
  }
  return parsed;
}

/** 継承を解かない生の JSON（設計 #1・#2・#4）。読めなければ落とす。 */
export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`型検査の設定が無い: ${path}`);
  }
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
  if (error !== undefined) {
    throw new Error(`型検査の設定を読めない: ${path}\n${describeDiagnostics([error])}`);
  }
  return config as Record<string, unknown>;
}

/** プログラムの options。ディスクへ何も書かない（設計 §10 の「プログラム」）。 */
export function programOptions(parsed: ts.ParsedCommandLine): ts.CompilerOptions {
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };
  delete options.tsBuildInfoFile;
  return options;
}

export interface BundledPlugin {
  /** `plugins/` の直下のディレクトリ名。 */
  readonly id: string;
  /** エントリ（`index.ts` か `index.tsx`）の絶対パス。区切りは `/`。 */
  readonly entry: string;
}

/**
 * 同梱 Plugin の列挙（設計 §10 の定義）。`plugins/` の直下のディレクトリで、
 * `plugin.json` と `index.ts` または `index.tsx` を持つもの。名前は書き並べない。
 */
export function listBundledPlugins(): readonly BundledPlugin[] {
  const found: BundledPlugin[] = [];
  for (const name of readdirSync(PLUGINS_DIR).sort()) {
    const dir = `${PLUGINS_DIR}/${name}`;
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(`${dir}/plugin.json`)) continue;
    const entry = ['index.ts', 'index.tsx'].find((file) => existsSync(`${dir}/${file}`));
    if (entry === undefined) continue;
    found.push({ id: name, entry: `${dir}/${entry}` });
  }
  return found;
}

const registryMemo = new Map<string, string>();

/**
 * `ids` を除いた `plugins/` の写しと生成スクリプトを一時ディレクトリへ置いて走らせ、
 * 出力されたレジストリの中身を返す（設計 §10 の「X を隠す」）。
 * 写しの中で走らせるので、リポジトリの `generated-registry.ts` は書き換わらない。
 */
export function generateRegistryWithout(ids: readonly string[]): string {
  const memoKey = [...ids].sort().join('\0');
  const memo = registryMemo.get(memoKey);
  if (memo !== undefined) return memo;

  const hiddenDirs = ids.map((id) => `${PLUGINS_DIR}/${id}`);
  const work = toPosix(mkdtempSync(join(tmpdir(), 'torifune-052-')));
  try {
    const script = `${work}/scripts/generate-plugin-registry.mjs`;
    cpSync(GENERATOR_PATH, script);
    cpSync(PLUGINS_DIR, `${work}/plugins`, {
      recursive: true,
      filter: (source) => !hiddenDirs.some((dir) => isUnder(source, dir)),
    });
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
    const text = readFileSync(`${work}/apps/web/src/plugin/generated-registry.ts`, 'utf8');
    registryMemo.set(memoKey, text);
    return text;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** レジストリの中の `import pluginN from '../../../../plugins/<dir>/index'` の `<dir>` の一覧。 */
export function registryPluginDirectories(registry: string): readonly string[] {
  return [
    ...registry.matchAll(
      /^import plugin\d+ from '\.\.\/\.\.\/\.\.\/\.\.\/plugins\/([^/']+)\/index';$/gm,
    ),
  ].map((match) => match[1] as string);
}

/**
 * 解析の使い回し（実装プラン §8 の 2）。パス × 生成の options × 中身 → SourceFile。
 * 中身が同じなら同じ SourceFile を返すので、2 つ目からのプログラムは差し替えたファイルだけを解析する。
 */
const sourceFileCache = new Map<string, Map<string, ts.SourceFile>>();

function sourceFileCacheKey(
  fileName: string,
  languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
): string {
  const v = languageVersionOrOptions;
  const optionsKey =
    typeof v === 'object'
      ? `${v.languageVersion}:${v.impliedNodeFormat}:${v.jsDocParsingMode}`
      : `${v}`;
  return `${pathKey(fileName)}|${optionsKey}`;
}

export interface HostOverrides {
  /** 隠す同梱 Plugin の ID。`plugins/<id>` とその下を「無い」と答える。 */
  readonly hidden?: readonly string[];
  /** `generated-registry.ts` の中身として返すもの。省略するとディスクのものを使う。 */
  readonly registry?: string;
  /** 型の誤りを足すファイルの絶対パス。 */
  readonly injectErrorsInto?: readonly string[];
}

/** 設計 §10 の「X を隠す」「F に型の誤りを足す」を行う CompilerHost。 */
export function createBuildCompilerHost(
  options: ts.CompilerOptions,
  overrides: HostOverrides = {},
): ts.CompilerHost {
  const base = ts.createCompilerHost(options, true);
  const hiddenDirs = (overrides.hidden ?? []).map((id) => `${PLUGINS_DIR}/${id}`);
  const injected = new Set((overrides.injectErrorsInto ?? []).map(pathKey));
  const registry = overrides.registry;

  const isHidden = (path: string): boolean => hiddenDirs.some((dir) => isUnder(path, dir));
  const isRegistry = (path: string): boolean =>
    registry !== undefined && samePath(path, REGISTRY_PATH);

  const readFile = (fileName: string): string | undefined => {
    if (isHidden(fileName)) return undefined;
    const text = isRegistry(fileName) ? registry : base.readFile(fileName);
    if (text === undefined) return undefined;
    return injected.has(pathKey(fileName)) ? `${text}${INJECTED_ERROR}` : text;
  };

  const host: ts.CompilerHost = {
    ...base,
    fileExists: (fileName) => {
      if (isHidden(fileName)) return false;
      if (isRegistry(fileName)) return true;
      return base.fileExists(fileName);
    },
    directoryExists: (directoryName) => {
      if (isHidden(directoryName)) return false;
      return base.directoryExists?.(directoryName) ?? ts.sys.directoryExists(directoryName);
    },
    getDirectories: (path) =>
      (base.getDirectories?.(path) ?? []).filter((name) => !isHidden(`${toPosix(path)}/${name}`)),
    readFile,
    getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const text = readFile(fileName);
      if (text === undefined) {
        if (!isHidden(fileName)) onError?.(`ファイルを読めない: ${fileName}`);
        return undefined;
      }
      if (shouldCreateNewSourceFile === true) {
        return ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      }
      const key = sourceFileCacheKey(fileName, languageVersionOrOptions);
      let byText = sourceFileCache.get(key);
      if (byText === undefined) {
        byText = new Map();
        sourceFileCache.set(key, byText);
      }
      let sourceFile = byText.get(text);
      if (sourceFile === undefined) {
        sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
        byText.set(text, sourceFile);
      }
      return sourceFile;
    },
  };
  // 包んだ getSourceFile を必ず通らせる（パスで引く経路があれば素通りされる）。
  delete host.getSourceFileByPath;
  return host;
}

export interface TypecheckProgramRequest extends Omit<HostOverrides, 'registry'> {
  readonly config: ConfigKind;
  /** 実装プラン §8 の 2 の規則でだけ渡す（新しいプログラムのファイルの集合を包むもの）。 */
  readonly oldProgram?: ts.Program;
}

export interface TypecheckProgram {
  readonly program: ts.Program;
  /** その設定の root files（区切りは `/`）。 */
  readonly rootNames: readonly string[];
  /** 隠したときに渡したレジストリの中身。何も隠さないときは `undefined`（ディスクのものを使う）。 */
  readonly registry: string | undefined;
}

/**
 * 設定からプログラムを組む。何かを隠すときは、隠した Plugin を除いて生成したレジストリを渡す。
 */
export function createTypecheckProgram(request: TypecheckProgramRequest): TypecheckProgram {
  const parsed = readParsedConfig(request.config);
  const options = programOptions(parsed);
  const hidden = request.hidden ?? [];
  const registry = hidden.length > 0 ? generateRegistryWithout(hidden) : undefined;
  const host = createBuildCompilerHost(options, {
    hidden,
    registry,
    injectErrorsInto: request.injectErrorsInto,
  });
  const rootNames = parsed.fileNames.map(toPosix);
  const program = ts.createProgram({
    rootNames,
    options,
    host,
    oldProgram: request.oldProgram,
  });
  return { program, rootNames, registry };
}

/** 設計 §10 の「誤り」：`getPreEmitDiagnostics` のうち category が Error のもの。 */
export function typeErrors(program: ts.Program): readonly ts.Diagnostic[] {
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
}

/** 失敗の文に出す誤りの一覧（ファイル・code・文）。 */
export function formatErrors(diagnostics: readonly ts.Diagnostic[]): string {
  if (diagnostics.length === 0) return '(誤りなし)';
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => '\n',
  });
}

/** 誤りのファイル（区切りは `/`）。ファイルを持たない誤りは空文字。 */
export function diagnosticFile(diagnostic: ts.Diagnostic): string {
  return diagnostic.file === undefined ? '' : toPosix(diagnostic.file.fileName);
}

export function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

/**
 * 設計 #7 の条件：ビルドの型検査から外れるべきファイルか。
 * テストファイル（`*.test.ts(x)`・`*.spec.ts(x)`）・`src/test-support/`・`e2e/`・`playwright.config.ts`。
 */
export function isTestOnlyFile(path: string): boolean {
  const p = toPosix(path);
  return (
    /\.(test|spec)\.tsx?$/.test(p) ||
    isUnder(p, `${WEB_SRC_DIR}/test-support`) ||
    isUnder(p, `${WEB_DIR}/e2e`) ||
    samePath(p, `${WEB_DIR}/playwright.config.ts`)
  );
}

/**
 * 設計 #15：`fileName` の import 指定子（静的 import・`export … from`・`import()`・`require()`）のうち、
 * 解決先が `<リポジトリ>/plugins/` の下になるものを返す。
 * 相対指定子はファイルの場所から、`@/` は `apps/web/src` から解決する（拡張子は補わない）。
 */
export function pluginImportSpecifiers(fileName: string, text: string): readonly string[] {
  const { importedFiles } = ts.preProcessFile(text, true, true);
  const found: string[] = [];
  for (const { fileName: specifier } of importedFiles) {
    let target: string | undefined;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      target = resolve(dirname(fileName), specifier);
    } else if (specifier.startsWith('@/')) {
      target = resolve(WEB_SRC_DIR, specifier.slice(2));
    }
    if (target !== undefined && isUnder(toPosix(target), PLUGINS_DIR)) {
      found.push(specifier);
    }
  }
  return found;
}
