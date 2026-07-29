// SPDX-License-Identifier: MPL-2.0

import path from 'node:path';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateArchiveEntryName(entryName) {
  assert(
    typeof entryName === 'string' && entryName.length > 0,
    'SB3 archive contains an empty entry name.',
  );
  assert(
    !entryName.includes('\0'),
    `SB3 archive entry contains a NUL byte: ${JSON.stringify(entryName)}`,
  );
  assert(
    !entryName.includes('\\'),
    `SB3 archive entry uses a backslash: ${JSON.stringify(entryName)}`,
  );
  assert(
    !path.posix.isAbsolute(entryName) && !/^[A-Za-z]:/u.test(entryName),
    `SB3 archive entry is absolute: ${JSON.stringify(entryName)}`,
  );

  const segments = entryName.replace(/\/$/u, '').split('/');
  assert(
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    `SB3 archive entry contains an unsafe path segment: ${JSON.stringify(entryName)}`,
  );
  return entryName;
}
