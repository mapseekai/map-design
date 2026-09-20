#!/usr/bin/env node

import { runMapDesignCli } from './map-design-cli.js';

const exitCode = await runMapDesignCli(process.argv.slice(2));
process.exitCode = exitCode;
