// SPDX-License-Identifier: MPL-2.0
import {describe, expect, it} from 'vitest';
import {indexNpmDistribution, readBounded} from '../src/distribution-archive';

function tar(entries: {name: string; type?: string; body?: string}[]) {
  const blocks: Buffer[] = [];
  for (const {name, type = '0', body = ''} of entries) {
    const bytes = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(bytes.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156);
    header.write(type + 'ustar', 156);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Uint8Array.from(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe('bounded distribution archives', () => {
  it.each([
    {name: 'package/../../private'},
    {name: '/package/dist/extension.js'},
    {name: 'package/dist\\extension.js'},
    {name: 'package/ignored-link', type: '2'},
    {name: 'package/hard-link', type: '1'},
  ])('rejects unsafe entries even outside selected dist files: %o', (entry) => {
    expect(() => indexNpmDistribution(tar([entry]))).toThrow('Unsafe');
  });

  it('rejects duplicate and excessive entries', () => {
    expect(() =>
      indexNpmDistribution(tar([{name: 'package/ignored'}, {name: 'package/ignored'}])),
    ).toThrow('duplicate');
    expect(() =>
      indexNpmDistribution(
        tar(Array.from({length: 4097}, (_, index) => ({name: 'package/' + index}))),
      ),
    ).toThrow('Too many');
  });

  it('cancels a stalled stream and rejects an oversized response', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const read = readBounded(stream, 1024, controller.signal);
    controller.abort();
    await expect(read).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
    await expect(readBounded(new Response('too much').body, 2)).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
    });
  });
});
