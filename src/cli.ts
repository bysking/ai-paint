#!/usr/bin/env node
/**
 * CLI entry — same as src/index.ts, for the package bin.
 */

import { McpServer } from './mcp/server.js'

const server = new McpServer()
await server.run()
