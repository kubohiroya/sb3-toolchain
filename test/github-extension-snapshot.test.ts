// SPDX-License-Identifier: MPL-2.0
import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {
  resolveGitHubExtensionSnapshot,
  buildStandardExtension,
} from '../src/standard-extension-build';
import {standardBuildFixture} from './standard-build-fixture';

const repository = 'outside-editor/sample';
const root = 'https://api.github.com/repos/' + repository;
const commit = 'a'.repeat(40);
const treeSHA = 'b'.repeat(40);
function fixture() {
  const files = standardBuildFixture();
  const routes: Record<string, unknown> = {};
  const tree: Record<string, unknown>[] = [];
  for (const [path, bytes] of files) {
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    tree.push({path, sha, mode: '100644', type: 'blob', size: bytes.length});
    routes[root + '/git/blobs/' + sha] = {
      sha,
      encoding: 'base64',
      size: bytes.length,
      content: Buffer.from(bytes).toString('base64'),
    };
  }
  tree.push({path: 'vite.config.ts', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 10});
  routes[root + '/commits/main'] = {sha: commit, commit: {tree: {sha: treeSHA}}};
  const treeData = {sha: treeSHA, truncated: false, tree};
  routes[root + '/git/trees/' + treeSHA + '?recursive=1'] = treeData;
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    routes[String(url)] ? Response.json(routes[String(url)]) : new Response(null, {status: 404}),
  );
  return {files, treeData, routes, fetchImpl};
}

describe('GitHub standard source snapshots', () => {
  it('pins the commit, verifies Git blobs and builds without fetching executable config', async () => {
    const f = fixture();
    const snapshot = await resolveGitHubExtensionSnapshot('https://github.com/' + repository, {
      ref: 'main',
      fetchImpl: f.fetchImpl,
    });
    expect(snapshot.files).toEqual(f.files);
    expect(snapshot.source).toEqual({kind: 'github', repository, commit});
    expect(snapshot.measurements.snapshotBytes).toBe(
      [...f.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    );
    const result = await buildStandardExtension(snapshot.files, {source: snapshot.source});
    expect(result.receipt.source).toEqual(snapshot.source);
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      root + '/git/blobs/' + 'c'.repeat(40),
    );
    for (const [, options] of f.fetchImpl.mock.calls)
      expect(options).toMatchObject({credentials: 'omit', redirect: 'error'});
  });

  it('refuses moved refs before fetching a source tree', async () => {
    const f = fixture();
    await expect(
      resolveGitHubExtensionSnapshot('https://github.com/' + repository, {
        ref: 'main',
        expectedCommit: 'd'.repeat(40),
        fetchImpl: f.fetchImpl,
      }),
    ).rejects.toThrow('commit changed');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['symlink', 'traversal', 'truncated', 'oversized', 'corrupt blob'])(
    'rejects %s source snapshots without a completed candidate',
    async (attack) => {
      const f = fixture();
      if (attack === 'symlink')
        f.treeData.tree.unshift({
          path: 'src/secret.ts',
          mode: '120000',
          type: 'blob',
          sha: 'c'.repeat(40),
          size: 10,
        });
      if (attack === 'traversal')
        f.treeData.tree.unshift({
          path: 'src/../private.ts',
          mode: '100644',
          type: 'blob',
          sha: 'c'.repeat(40),
          size: 10,
        });
      if (attack === 'truncated') f.treeData.truncated = true;
      if (attack === 'oversized') f.treeData.tree[0]!.size = 1024 * 1024 + 1;
      if (attack === 'corrupt blob') {
        const url = root + '/git/blobs/' + f.treeData.tree[0]!.sha;
        (f.routes[url] as Record<string, unknown>).content =
          Buffer.from('corrupt').toString('base64');
      }
      await expect(
        resolveGitHubExtensionSnapshot('https://github.com/' + repository, {
          ref: 'main',
          fetchImpl: f.fetchImpl,
        }),
      ).rejects.toThrow();
    },
  );
});
