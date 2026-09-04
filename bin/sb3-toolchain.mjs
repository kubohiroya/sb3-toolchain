#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import {runCli} from '../dist/cli.js';

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
