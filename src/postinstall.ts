import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const manualCommand = "opencode-multireview skill install --global"

type PostinstallOptions = {
  isTTY?: boolean
  ask?: () => Promise<string>
  install?: () => void
  write?: (message: string) => void
}

function askForInstall(): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<string>((resolveAnswer) => {
      readline.question("Install standalone skill copy (optional)? [y/N]", (answer) => {
      readline.close()
      resolveAnswer(answer)
    })
  })
}

function installGlobalSkill(): void {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url))
  const result = spawnSync(process.execPath, [cliPath, "skill", "install", "--global"], { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`installer exited with status ${result.status ?? "unknown"}`)
}

export async function runPostinstall(options: PostinstallOptions = {}): Promise<void> {
  const write = options.write ?? ((message: string) => process.stdout.write(message))
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!isTTY) {
     write(`MMAR skill installation skipped (non-interactive; plugin-loaded discovery is automatic). Optional standalone fallback: ${manualCommand}\n`)
    return
  }

  const answer = await (options.ask ?? askForInstall)()
   if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
     write(`MMAR skill installation skipped; plugin-loaded discovery is automatic. Optional standalone fallback: ${manualCommand}\n`)
    return
  }

  try {
    (options.install ?? installGlobalSkill)()
  } catch {
    write(`MMAR skill installation could not be completed. Run: ${manualCommand}\n`)
  }
}

export async function main(): Promise<void> {
  await runPostinstall()
}

if (process.argv[1] && realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(resolve(process.argv[1]))) {
  main().catch((error: Error) => {
    process.stderr.write(`MMAR postinstall failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
