import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIR, loadConfig, log, saveConfig } from './config.ts'
import { startBridge } from './server.ts'

process.on('uncaughtException', error => log(`uncaught: ${error.stack ?? error.message}`))
process.on('unhandledRejection', reason => log(`unhandled: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`))

const config = loadConfig()

try {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

  await startBridge({ config, saveConfig, log, galleryDir: join(HOME_DIR, 'gallery'), uploadsDir: join(HOME_DIR, 'uploads'), docBackupDir: join(HOME_DIR, 'doc-backups'), claudeDir })
} catch (error) {
  const code = error instanceof Error && 'code' in error ? error.code : null

  // Another bridge already owns the port: that one keeps serving.
  if (code === 'EADDRINUSE') {
    log('port in use, another bridge is running')
    process.exit(0)
  }

  log(`start failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
}
