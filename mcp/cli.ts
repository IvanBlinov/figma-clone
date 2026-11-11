#!/usr/bin/env node
// Standalone MCP server: stdio by default, or Streamable HTTP with --http <port>.
import { main } from './server'

await main()
