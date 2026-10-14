import { execFileSync, spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

function versionOf(command) {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

export function resolveOpenCodeV2() {
  const configured = process.env.OPENCODE_V2_BIN
  if (configured) {
    const version = versionOf(configured)
    return /^opencode v?2\./i.test(version ?? "")
      ? { bin: configured }
      : { reason: `OPENCODE_V2_BIN is not a working OpenCode V2 binary${version ? ` (reported ${version})` : ""}` }
  }

  const version = versionOf("opencode")
  return /^opencode v?2\./i.test(version ?? "")
    ? { bin: "opencode" }
    : { reason: `OpenCode V2 unavailable: PATH opencode${version ? ` reports ${version}` : " was not found or could not run"}; set OPENCODE_V2_BIN to a V2 binary` }
}

export function isolatedEnvironment(directory) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENCODE")))
  Object.assign(environment, {
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "xdg-config"),
    XDG_DATA_HOME: join(directory, "xdg-data"),
    XDG_STATE_HOME: join(directory, "xdg-state"),
    XDG_CACHE_HOME: join(directory, "xdg-cache"),
  })
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    mkdirSync(environment[name], { recursive: true })
  }
  return environment
}

export function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

export async function startOpenCodeServer(bin, cwd, env) {
  const port = await reservePort()
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: { ...env, OPENCODE_SERVER_PASSWORD: "mmar-isolated-test-password" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output = []
  child.stdout.on("data", (chunk) => output.push(chunk.toString()))
  child.stderr.on("data", (chunk) => output.push(chunk.toString()))
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`OpenCode server exited (${child.exitCode})\n${output.join("")}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/global/health`)
        if (response.ok) return { child, port, output }
      } catch {
        // The server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`OpenCode server did not become ready\n${output.join("")}`)
  } catch (error) {
    await stopOpenCodeServer(child)
    throw error
  }
}

export async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: apiHeaders() })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`)
  const value = await response.json()
  return Array.isArray(value) ? value : value.data ?? value
}

export async function waitForPlugin(port, path, matches, output, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastResponse = "No plugin response received"
  while (Date.now() < deadline) {
    try {
      const plugins = await getJson(port, path)
      lastResponse = JSON.stringify(plugins)
      const plugin = plugins.find(matches)
      if (plugin) return plugin
    } catch (error) {
      lastResponse = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Plugin did not appear at ${path} within ${timeoutMs}ms; last response: ${lastResponse}; server output: ${output.join("")}`)
}

export function apiHeaders() {
  return { authorization: `Basic ${Buffer.from("opencode:mmar-isolated-test-password").toString("base64")}` }
}

export async function stopOpenCodeServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => child.once("exit", resolve))
}
