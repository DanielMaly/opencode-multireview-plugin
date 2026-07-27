#!/usr/bin/env node
const { existsSync } = require("node:fs")
const { spawnSync } = require("node:child_process")
const { join } = require("node:path")

const manualCommand = "opencode-multireview skill install --global"
const compiledPostinstall = join(__dirname, "..", "dist", "postinstall.js")

function write(message) {
  process.stdout.write(message)
}

function manualGuidance(message) {
  write(`${message} Run: ${manualCommand}\n`)
}

function sourceCheckoutFallback() {
  manualGuidance("MMAR skill installation skipped (source checkout is not built; run npm run build first).")
}

function runCompiledPostinstall() {
  const result = spawnSync(process.execPath, [compiledPostinstall], { stdio: "inherit" })
  if (result.error || result.status !== 0) {
    manualGuidance("MMAR skill installation could not be completed.")
  }
}

function run() {
  if (existsSync(compiledPostinstall)) runCompiledPostinstall()
  else sourceCheckoutFallback()
}

if (require.main === module) {
  try {
    run()
  } catch {
    manualGuidance("MMAR skill installation could not be completed.")
  }
}

module.exports = {
  run,
  runCompiledPostinstall,
  sourceCheckoutFallback,
}
