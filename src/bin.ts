// SPDX-License-Identifier: MPL-2.0

import process from 'node:process';

import {runCli} from './cli';
import {errorMessage} from './assert';

runCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
