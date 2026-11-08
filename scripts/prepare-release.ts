// Bring every place that names the release version in line with package.json.
// The family release executor runs this as `release:prepare` with RELEASE_VERSION set.
// Running it again for the same version changes nothing.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {version: string};
const version = process.env.RELEASE_VERSION ?? packageJson.version;
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), `invalid release version: ${version}`);
assert.equal(packageJson.version, version, 'package.json must already carry the release version.');

const constantsPath = 'src/constants.ts';
const constants = readFileSync(constantsPath, 'utf8');
const current = /export const packageVersion = '([^']+)';/u.exec(constants)?.[1];
assert(current, `${constantsPath} must declare packageVersion.`);

function replaceIn(path: string, from: string, to: string): void {
  const source = readFileSync(path, 'utf8');
  const next = source.split(from).join(to);
  if (next !== source) writeFileSync(path, next);
}

if (current !== version) {
  replaceIn(constantsPath, `packageVersion = '${current}'`, `packageVersion = '${version}'`);
  for (const path of ['README.md', 'README.ja.md', 'docs/index.html']) {
    replaceIn(path, `@kubohiroya/sb3-toolchain@${current}`, `@kubohiroya/sb3-toolchain@${version}`);
  }
}

const changelogPath = 'CHANGELOG.md';
const changelog = readFileSync(changelogPath, 'utf8');
if (!changelog.includes(`\n## ${version} - `)) {
  let log = '';
  try {
    log = execFileSync('git', ['log', '--no-merges', '--format=%s', `v${current}..HEAD`], {
      encoding: 'utf8',
    });
  } catch {
    // Without the previous tag the section falls back to a generic entry.
  }
  const subjects = log
    .split('\n')
    .map((subject) => subject.trim())
    .filter((subject) => subject && !subject.startsWith('chore(release)'));
  const date = new Date().toISOString().slice(0, 10);
  const entries = subjects.length > 0 ? subjects : ['依存関係を更新した。'];
  const section = [
    `## ${version} - ${date}`,
    '',
    ...entries.map((subject) => `- ${subject}`),
    '',
  ].join('\n');
  writeFileSync(
    changelogPath,
    changelog.replace(/^# Changelog\n\n/u, `# Changelog\n\n${section}\n`),
  );
}
