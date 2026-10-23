#!/usr/bin/env node
'use strict';

/**
 * Entry point for the Codex lifecycle hooks.
 *
 * Keeping this path stable matters: ~/.codex/config.toml references it, and the
 * hook trust records are keyed on that command line — moving the file would make
 * Codex ask for trust again. The implementation lives in src/hook.js.
 */

require('./src/hook.js');
