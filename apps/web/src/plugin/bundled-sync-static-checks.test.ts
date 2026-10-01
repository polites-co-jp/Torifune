import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 同梱 Plugin の同期まわりの静的検査（050-bundled-plugin-sync 設計 §6.1・§6.4.3・§6.7.2・§10.6、
 * 受け入れ条件 #51〜#53。種別 E）。
 *
 * 検査の本体は**文字列を受け取る関数**としてここに置き、実物のファイルに当てる件と、
 * 判別力として**条件を消した・順序を入れ替えた写し**に当てる件を並べる
 * （`publish-claim-static-checks.test.ts` の流儀。実装プラン §2「テストの方法」の E）。
 *
 * * `#51`：`scripts/generate-plugin-registry.mjs` の走査が、名前が `.` で始まるディレクトリを
 *   `plugin.json` を読む前に飛ばす（作業用の `.torifune-sync-<id>.tmp` は `plugin.json` を持つ。設計 §6.4.3）
 * * `#52`：`Dockerfile` が、同梱の写しを作る手順と `TORIFUNE_BUNDLED_PLUGINS_DIR` を `VOLUME` より前に置き、
 *   指紋を `.next/torifune-plugin-sources` へ書く手順を web のビルドの後に置く（設計 §6.1・§6.7.2）
 * * `#53`：`.github/workflows/ci.yml` の `container` ジョブが、既存の検証の後に
 *   `./scripts/verify-bundled-plugin-sync.sh` を走らせる。ジョブ名は変えない（実装プラン §8 の 15）
 *
 * コメントの中に書いただけのものは数えない（コメントを外してから見る）。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), 'utf8').replaceAll('\r\n', '\n');
}

// ---------------------------------------------------------------------------
// #51 生成スクリプト
// ---------------------------------------------------------------------------

/** 名前が `.` で始まるかを確かめる書き方（どれか 1 つでよい）。`<v>` は走査の変数。 */
function dotPrefixPatterns(variable: string): readonly RegExp[] {
  const v = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`${v}\\.name\\.startsWith\\(\\s*['"]\\.['"]\\s*\\)`),
    new RegExp(`${v}\\.name\\[0\\]\\s*===\\s*['"]\\.['"]`),
    new RegExp(`${v}\\.name\\.charAt\\(\\s*0\\s*\\)\\s*===\\s*['"]\\.['"]`),
    new RegExp(`/\\^\\\\\\./\\.test\\(\\s*${v}\\.name\\s*\\)`),
  ];
}

/** `/* … *\/` と行の `// …` を除く（文字列の中の `//` は、この検査の範囲では現れない）。 */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

/**
 * 生成スクリプトの走査が `.` で始まるディレクトリを飛ばしているか。
 *
 * `for (const <v> of readdirSync(pluginsDir, …))` の本文で、`.` で始まる名前の条件が `continue` を伴い、
 * `plugin.json` を読むより前に現れること。
 */
function generatorSkipsDotDirectories(rawSource: string): boolean {
  const source = stripJsComments(rawSource);
  const loop = /for\s*\(\s*const\s+(\w+)\s+of\s+readdirSync\(\s*pluginsDir\b/.exec(source);
  if (loop === null) return false;
  const variable = loop[1] ?? '';
  const body = source.slice(loop.index);
  const manifestIndex = body.indexOf("'plugin.json'");
  if (manifestIndex === -1) return false;
  const beforeManifest = body.slice(0, manifestIndex);

  return dotPrefixPatterns(variable).some((pattern) => {
    const match = pattern.exec(beforeManifest);
    if (match === null) return false;
    // 条件の直後（同じ文の中）で continue する。
    const after = beforeManifest.slice(match.index, match.index + 200);
    return (
      /^[^;]*?\)\s*(\{\s*)?continue\b/.test(after) ||
      /continue\s*;/.test(after.split('\n')[0] ?? '')
    );
  });
}

const GENERATOR_WITHOUT_DOT_SKIP = `
function discover() {
  const entries = [];
  for (const name of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;

    if (existsSync(join(pluginsDir, name.name, '.torifune-quarantine'))) {
      continue;
    }

    const manifestPath = join(pluginsDir, name.name, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    entries.push({ directory: name.name });
  }
  return entries;
}
`;

function withDotSkip(condition: string): string {
  return GENERATOR_WITHOUT_DOT_SKIP.replace(
    '    if (!name.isDirectory()) continue;\n',
    `    if (!name.isDirectory()) continue;\n    ${condition}\n`,
  );
}

describe('#51 生成スクリプト', () => {
  it('#51 generate-plugin-registry.mjs の走査が、名前が . で始まるディレクトリを plugin.json を読む前に飛ばす', () => {
    expect(
      generatorSkipsDotDirectories(readRepoFile('scripts', 'generate-plugin-registry.mjs')),
    ).toBe(true);
  });

  it('#51 判別力：. で始まる名前の条件が無い走査は見分ける', () => {
    expect(generatorSkipsDotDirectories(GENERATOR_WITHOUT_DOT_SKIP)).toBe(false);
  });

  it('#51 判別力：条件をコメントに書いただけのものは数えない', () => {
    expect(
      generatorSkipsDotDirectories(withDotSkip("// if (name.name.startsWith('.')) continue;")),
    ).toBe(false);
  });

  it('#51 判別力：条件が plugin.json を読んだ後にあるものは見分ける', () => {
    const late = GENERATOR_WITHOUT_DOT_SKIP.replace(
      '    entries.push({ directory: name.name });\n',
      "    if (name.name.startsWith('.')) continue;\n    entries.push({ directory: name.name });\n",
    );

    expect(generatorSkipsDotDirectories(late)).toBe(false);
  });

  it.each([
    "if (name.name.startsWith('.')) continue;",
    "if (name.name[0] === '.') continue;",
    "if (name.name.charAt(0) === '.') {\n      continue;\n    }",
    'if (/^\\./.test(name.name)) continue;',
  ])('#51 判別力：%s の書き方は飛ばしているとみなす', (condition) => {
    expect(generatorSkipsDotDirectories(withDotSkip(condition))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #52 Dockerfile
// ---------------------------------------------------------------------------

interface Instruction {
  readonly keyword: string;
  readonly text: string;
}

/**
 * Dockerfile を命令の並びにする。コメントの行（`#` で始まる行。継続行の途中のものを含む）を除き、
 * 行末の `\` による継続を 1 行につなぐ。
 */
function dockerInstructions(source: string): readonly Instruction[] {
  const lines = source.split('\n').filter((line) => !/^\s*#/.test(line));
  const joined = lines.join('\n').replace(/\\\n/g, ' ');
  return joined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const keyword = (line.split(/\s+/)[0] ?? '').toUpperCase();
      return { keyword, text: line };
    });
}

const BUNDLED_ENV = /\bTORIFUNE_BUNDLED_PLUGINS_DIR=\/app\/\.torifune-bundled-plugins(\s|$)/;
const BUNDLED_COPY =
  /\bcp\s+-a\s+(\/app\/)?plugins(\/\.?)?\s+(\/app\/)?\.torifune-bundled-plugins\/?(\s|$|&|;)/;
const WEB_BUILD = /pnpm\s+--filter\s+@torifune\/web\s+build\b/;
const FINGERPRINT_WRITE =
  /\bplugins\s+fingerprint\b[^>&;|]*--plugins-dir=\/app\/plugins\b[^>&;|]*>\s*(\/app\/)?apps\/web\/\.next\/torifune-plugin-sources\b/;

/** 命令の中で条件に合う最初の位置（命令の番号）。無ければ -1。 */
function indexOf(
  instructions: readonly Instruction[],
  predicate: (instruction: Instruction) => boolean,
): number {
  return instructions.findIndex(predicate);
}

/** 問題の一覧を返す。空なら合格。 */
function dockerfileProblems(source: string): readonly string[] {
  const instructions = dockerInstructions(source);
  const problems: string[] = [];

  const volume = indexOf(
    instructions,
    (i) => i.keyword === 'VOLUME' && i.text.includes('/app/plugins'),
  );
  if (volume === -1) problems.push('VOLUME /app/plugins が無い');

  const env = indexOf(instructions, (i) => i.keyword === 'ENV' && BUNDLED_ENV.test(i.text));
  if (env === -1)
    problems.push('ENV TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins が無い');

  const build = indexOf(instructions, (i) => i.keyword === 'RUN' && WEB_BUILD.test(i.text));
  if (build === -1) problems.push('web のビルドの RUN が無い');

  const copy = indexOf(instructions, (i) => i.keyword === 'RUN' && BUNDLED_COPY.test(i.text));
  if (copy === -1)
    problems.push(
      '同梱の写しを作る RUN（cp -a /app/plugins /app/.torifune-bundled-plugins）が無い',
    );

  const fingerprint = indexOf(
    instructions,
    (i) => i.keyword === 'RUN' && FINGERPRINT_WRITE.test(i.text),
  );
  if (fingerprint === -1) {
    problems.push('指紋を apps/web/.next/torifune-plugin-sources へ書く RUN が無い');
  }

  if (volume !== -1 && env !== -1 && env > volume) problems.push('ENV が VOLUME より後にある');
  if (volume !== -1 && copy !== -1 && copy > volume) problems.push('写しが VOLUME より後にある');
  if (build !== -1 && copy !== -1) {
    // 写しはビルドの後（同じ RUN の中なら、ビルドの文字列より後ろ）。
    const sameRun = copy === build;
    const text = instructions[copy]?.text ?? '';
    const before = sameRun ? text.search(BUNDLED_COPY) < text.search(WEB_BUILD) : copy < build;
    if (before) problems.push('写しが web のビルドより前にある');
  }
  if (build !== -1 && fingerprint !== -1) {
    const sameRun = fingerprint === build;
    const text = instructions[fingerprint]?.text ?? '';
    const before = sameRun
      ? text.search(FINGERPRINT_WRITE) < text.search(WEB_BUILD)
      : fingerprint < build;
    if (before) problems.push('指紋の書き込みが web のビルドより前にある');
  }

  return problems;
}

const DOCKERFILE_PASSING = `FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \\
    # 説明のコメント
    TORIFUNE_PLUGINS_DIR=/app/plugins \\
    TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins \\
    TORIFUNE_SELF_RESTART=1

WORKDIR /app
COPY . .

RUN pnpm generate:plugins \\
 && pnpm --filter @torifune/cli build \\
 && pnpm --filter @torifune/web build

RUN cp -a /app/plugins /app/.torifune-bundled-plugins \\
 && node packages/cli/dist/main.js plugins fingerprint --plugins-dir=/app/plugins > apps/web/.next/torifune-plugin-sources

VOLUME ["/app/plugins"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
`;

describe('#52 Dockerfile', () => {
  it('#52 Dockerfile：同梱の写しと TORIFUNE_BUNDLED_PLUGINS_DIR が VOLUME より前、指紋の書き込みがビルドの後にある', () => {
    expect(dockerfileProblems(readRepoFile('Dockerfile'))).toEqual([]);
  });

  it('#52 判別力：手本の写しは合格する', () => {
    expect(dockerfileProblems(DOCKERFILE_PASSING)).toEqual([]);
  });

  it('#52 判別力：ENV の宣言が無いものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      '    TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins \\\n',
      '',
    );

    expect(dockerfileProblems(source)).toContain(
      'ENV TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins が無い',
    );
  });

  it('#52 判別力：ENV の宣言がコメントの中だけにあるものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      '    TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins \\\n',
      '    # TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins \\\n',
    );

    expect(dockerfileProblems(source)).toContain(
      'ENV TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins が無い',
    );
  });

  it('#52 判別力：写しが VOLUME より後にあるものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      'RUN cp -a /app/plugins /app/.torifune-bundled-plugins \\\n && ',
      'RUN ',
    ).replace(
      'VOLUME ["/app/plugins"]\n',
      'VOLUME ["/app/plugins"]\nRUN cp -a /app/plugins /app/.torifune-bundled-plugins\n',
    );

    expect(dockerfileProblems(source)).toContain('写しが VOLUME より後にある');
  });

  it('#52 判別力：ENV が VOLUME より後にあるものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      '    TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins \\\n',
      '',
    ).replace(
      'VOLUME ["/app/plugins"]\n',
      'VOLUME ["/app/plugins"]\nENV TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins\n',
    );

    expect(dockerfileProblems(source)).toContain('ENV が VOLUME より後にある');
  });

  it('#52 判別力：写しを作る手順が無いものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      'RUN cp -a /app/plugins /app/.torifune-bundled-plugins \\\n && ',
      'RUN ',
    );

    expect(dockerfileProblems(source)).toContain(
      '同梱の写しを作る RUN（cp -a /app/plugins /app/.torifune-bundled-plugins）が無い',
    );
  });

  it('#52 判別力：指紋の書き込みが web のビルドより前にあるものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      'RUN pnpm generate:plugins \\\n',
      'RUN node packages/cli/dist/main.js plugins fingerprint --plugins-dir=/app/plugins > apps/web/.next/torifune-plugin-sources\nRUN pnpm generate:plugins \\\n',
    ).replace(
      ' \\\n && node packages/cli/dist/main.js plugins fingerprint --plugins-dir=/app/plugins > apps/web/.next/torifune-plugin-sources',
      '',
    );

    expect(dockerfileProblems(source)).toContain('指紋の書き込みが web のビルドより前にある');
  });

  it('#52 判別力：指紋を書く手順が無いものは見分ける', () => {
    const source = DOCKERFILE_PASSING.replace(
      ' \\\n && node packages/cli/dist/main.js plugins fingerprint --plugins-dir=/app/plugins > apps/web/.next/torifune-plugin-sources',
      '',
    );

    expect(dockerfileProblems(source)).toContain(
      '指紋を apps/web/.next/torifune-plugin-sources へ書く RUN が無い',
    );
  });

  it('#52 判別力：写しと指紋がビルドと同じ RUN の後ろに続く形も合格する', () => {
    const source = DOCKERFILE_PASSING.replace(
      ' && pnpm --filter @torifune/web build\n\nRUN cp -a',
      ' && pnpm --filter @torifune/web build \\\n && cp -a',
    );

    expect(dockerfileProblems(source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #53 CI
// ---------------------------------------------------------------------------

const CONTAINER_JOB_NAME = 'container (plugin rebuild / rollback)';
const NEW_STEP = './scripts/verify-bundled-plugin-sync.sh';
const EXISTING_STEP = './scripts/verify-container-rebuild.sh';

/** `jobs:` の下の `  <id>:` から、次の同じ深さのジョブまで。無ければ null。 */
function jobBlock(workflow: string, id: string): string | null {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${id}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line) || /^\S/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** ジョブの中の `- run: <command>` の並び（コメントの行は除く）。 */
function runSteps(block: string): readonly string[] {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => /^\s*-?\s*run:\s*(.+?)\s*$/.exec(line)?.[1] ?? null)
    .filter((command): command is string => command !== null);
}

function ciProblems(workflow: string): readonly string[] {
  const block = jobBlock(workflow, 'container');
  if (block === null) return ['container ジョブが無い'];

  const problems: string[] = [];
  if (!block.includes(`name: ${CONTAINER_JOB_NAME}`)) {
    problems.push('container ジョブの名前が変わっている');
  }
  const steps = runSteps(block);
  const added = steps.indexOf(NEW_STEP);
  const existing = steps.indexOf(EXISTING_STEP);
  if (added === -1) problems.push(`container ジョブが ${NEW_STEP} を走らせない`);
  if (existing === -1) problems.push(`container ジョブが ${EXISTING_STEP} を走らせない`);
  if (added !== -1 && existing !== -1 && added < existing) {
    problems.push('新しい検証が既存の検証より前にある');
  }
  return problems;
}

const CI_PASSING = `name: CI

jobs:
  build:
    name: build
    steps:
      - run: pnpm build

  container:
    name: ${CONTAINER_JOB_NAME}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: ${EXISTING_STEP}
      - run: ${NEW_STEP}

  e2e:
    name: e2e
    steps:
      - run: pnpm test:e2e
`;

describe('#53 CI', () => {
  it('#53 ci.yml の container ジョブが、既存の検証の後に ./scripts/verify-bundled-plugin-sync.sh を走らせる', () => {
    expect(ciProblems(readRepoFile('.github', 'workflows', 'ci.yml'))).toEqual([]);
  });

  it('#53 判別力：手本の写しは合格する', () => {
    expect(ciProblems(CI_PASSING)).toEqual([]);
  });

  it('#53 判別力：新しい検証が無いものは見分ける', () => {
    const source = CI_PASSING.replace(`      - run: ${NEW_STEP}\n`, '');

    expect(ciProblems(source)).toContain(`container ジョブが ${NEW_STEP} を走らせない`);
  });

  it('#53 判別力：コメントにしただけのものは見分ける', () => {
    const source = CI_PASSING.replace(`      - run: ${NEW_STEP}\n`, `      # - run: ${NEW_STEP}\n`);

    expect(ciProblems(source)).toContain(`container ジョブが ${NEW_STEP} を走らせない`);
  });

  it('#53 判別力：別のジョブ（e2e）で走らせるものは見分ける', () => {
    const source = CI_PASSING.replace(`      - run: ${NEW_STEP}\n`, '').replace(
      '      - run: pnpm test:e2e\n',
      `      - run: pnpm test:e2e\n      - run: ${NEW_STEP}\n`,
    );

    expect(ciProblems(source)).toContain(`container ジョブが ${NEW_STEP} を走らせない`);
  });

  it('#53 判別力：既存の検証より前に置いたものは見分ける', () => {
    const source = CI_PASSING.replace(
      `      - run: ${EXISTING_STEP}\n      - run: ${NEW_STEP}\n`,
      `      - run: ${NEW_STEP}\n      - run: ${EXISTING_STEP}\n`,
    );

    expect(ciProblems(source)).toContain('新しい検証が既存の検証より前にある');
  });

  it('#53 判別力：ジョブの名前を変えたものは見分ける', () => {
    const source = CI_PASSING.replace(
      `name: ${CONTAINER_JOB_NAME}`,
      'name: container (plugin rebuild / rollback / bundled sync)',
    );

    expect(ciProblems(source)).toContain('container ジョブの名前が変わっている');
  });
});
