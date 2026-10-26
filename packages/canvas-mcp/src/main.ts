#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { TenonClient } from "./client.ts"
import { createServer } from "./server.ts"

const baseUrl =
  process.env.TENON_URL ??
  process.env.AMATERASU_URL ??
  "http://127.0.0.1:8787"

const server = createServer(new TenonClient(baseUrl))
await server.connect(new StdioServerTransport())
