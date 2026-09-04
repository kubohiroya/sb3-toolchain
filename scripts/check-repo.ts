// SPDX-License-Identifier: MPL-2.0

import {readFile} from 'node:fs/promises';

interface PackageJson {
  author: string;
  files: string[];
  homepage: string;
  license: string;
  name: string;
  packageManager: string;
  scripts: Record<string, string>;
  version: string;
}

interface RepoPolicy {
  authorPolicy: {email: boolean; name: string};
  homepage: string;
  license: string;
  packageName: string;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

const packageJson = await readJson<PackageJson>('package.json');
const policy = await readJson<RepoPolicy>('repo-policy.json');
const readme = await readFile('README.md', 'utf8');
const readmeJa = await readFile('README.ja.md', 'utf8');
const changelog = await readFile('CHANGELOG.md', 'utf8');
const license = await readFile('LICENSE', 'utf8');
const migrationDocs = await readFile('docs/extension-id-migration.md', 'utf8');
const migrationDocsJa = await readFile('docs/ja/extension-id-migration.md', 'utf8');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function includesEvery(value: string, snippets: string[], description: string): void {
  for (const snippet of snippets) {
    assert(value.includes(snippet), `${description} is missing: ${snippet}`);
  }
}

const version = packageJson.version;
const legacyLower = ['tm', 'pose'].join('');
const legacyPosePattern = new RegExp(
  `${legacyLower}|TM${'Pose'}|TM${'POSE'}|${['turbowarp-', 'tm', 'pose'].join('')}`,
  'u',
);

assert(packageJson.name === policy.packageName, 'package name must match repo policy.');
assert(packageJson.version === '0.11.0', 'package version must be 0.11.0.');
assert(packageJson.license === policy.license, 'package license must be MPL-2.0.');
assert(packageJson.author === policy.authorPolicy.name, 'package author must use the shared name.');
assert(!packageJson.author.includes('@'), 'package author must not include email.');
assert(packageJson.homepage === policy.homepage, 'package homepage must use GitHub Pages.');
assert(packageJson.packageManager === 'pnpm@11.11.0', 'package manager must stay pinned.');
assert(
  packageJson.scripts['repo:check'] === 'node --experimental-strip-types scripts/check-repo.ts',
  'repo:check script missing.',
);
assert(packageJson.scripts.check.includes('pnpm run repo:check'), 'check must include repo:check.');
assert(
  packageJson.scripts['release:check'].includes('npm publish --dry-run'),
  'release dry-run missing.',
);
assert(
  packageJson.files.includes('repo-policy.json'),
  'package files must include repo-policy.json.',
);
assert(packageJson.files.includes('CHANGELOG.md'), 'package files must include CHANGELOG.md.');

includesEvery(
  readme,
  [
    `@kubohiroya/sb3-toolchain@${version}`,
    'kubohiroya/tm-kamishibai',
    'TurboWarp TM',
    'SPDX-License-Identifier: MPL-2.0',
    'pnpm run check',
  ],
  'README.md',
);
includesEvery(
  readmeJa,
  [
    `@kubohiroya/sb3-toolchain@${version}`,
    'kubohiroya/tm-kamishibai',
    'TurboWarp TM',
    'SPDX-License-Identifier: MPL-2.0',
    'pnpm run check',
  ],
  'README.ja.md',
);
includesEvery(
  changelog,
  [`## ${version} - 2026-09-05`, 'release snapshot helpers'],
  'CHANGELOG.md',
);
includesEvery(license, ['Mozilla Public License Version 2.0', '3. Responsibilities'], 'LICENSE');
includesEvery(migrationDocs, ['kubohiroyatm', 'TurboWarp TM'], 'docs/extension-id-migration.md');
includesEvery(
  migrationDocsJa,
  ['kubohiroyatm', 'TurboWarp TM'],
  'docs/ja/extension-id-migration.md',
);

const legacyScannedFiles: [string, string][] = [
  ['README.md', readme],
  ['README.ja.md', readmeJa],
  ['docs/extension-id-migration.md', migrationDocs],
  ['docs/ja/extension-id-migration.md', migrationDocsJa],
  ['repo-policy.json', JSON.stringify(policy)],
];
for (const [description, value] of legacyScannedFiles) {
  assert(!legacyPosePattern.test(value), `${description} contains legacy pose-era spelling.`);
}

console.log(`repo policy check passed for ${packageJson.name}@${version}`);
