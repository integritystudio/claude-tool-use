#!/usr/bin/env node
/**
 * Syncs data from ~/.claude-history to matching directories in this repository.
 * Usage: node scripts/sync-history.js [--dry-run] [--verbose] [directory...]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  sourceBase: path.join(os.homedir(), '.claude-history'),
  targetBase: path.resolve(__dirname, '..'),

  // Directories to sync (must exist in both source and target)
  syncDirs: ['debug', 'file-history', 'projects', 'session-env', 'shell-snapshots', 'todos', 'archive'],

  // Files/patterns to exclude
  excludePatterns: ['.DS_Store', '*.tmp', '*.lock'],
};

// ============================================================================
// Utility Functions
// ============================================================================

const log = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  success: (msg) => console.log(`[OK] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  verbose: (msg, isVerbose) => isVerbose && console.log(`[DEBUG] ${msg}`),
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

function shouldExclude(filename) {
  return CONFIG.excludePatterns.some(pattern => {
    if (pattern.startsWith('*')) {
      return filename.endsWith(pattern.slice(1));
    }
    return filename === pattern;
  });
}

function getFileStats(filePath, followSymlinks = true) {
  try {
    return followSymlinks ? fs.statSync(filePath) : fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

// ============================================================================
// Sync Operations
// ============================================================================

function getFilesToSync(sourceDir, targetDir) {
  const files = [];

  if (!fs.existsSync(sourceDir)) {
    return files;
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldExclude(entry.name)) continue;

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...getFilesToSync(sourcePath, targetPath));
    } else {
      // Use lstat to not follow symlinks
      const sourceStats = getFileStats(sourcePath, false);
      const targetStats = getFileStats(targetPath, false);

      // Sync if target doesn't exist or source is newer
      const needsSync = !targetStats ||
        (sourceStats && sourceStats.mtime > targetStats.mtime);

      if (needsSync) {
        files.push({ source: sourcePath, target: targetPath, size: sourceStats?.size || 0 });
      }
    }
  }

  return files;
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyFile(source, target, dryRun = false) {
  if (dryRun) return true;

  try {
    ensureDir(path.dirname(target));

    if (isSymlink(source)) {
      const linkTarget = fs.readlinkSync(source);
      // Remove existing symlink/file if it exists
      if (fs.existsSync(target) || isSymlink(target)) {
        fs.unlinkSync(target);
      }
      fs.symlinkSync(linkTarget, target);
    } else {
      fs.copyFileSync(source, target);
    }
    return true;
  } catch (err) {
    log.error(`Failed to copy ${source}: ${err.message}`);
    return false;
  }
}

function syncDirectory(dirName, options = {}) {
  const { dryRun = false, verbose = false } = options;

  const sourceDir = path.join(CONFIG.sourceBase, dirName);
  const targetDir = path.join(CONFIG.targetBase, dirName);

  if (!fs.existsSync(sourceDir)) {
    log.warn(`Source directory not found: ${sourceDir}`);
    return { copied: 0, skipped: 0, errors: 0 };
  }

  const files = getFilesToSync(sourceDir, targetDir);
  let copied = 0, errors = 0;

  for (const file of files) {
    log.verbose(`Syncing: ${file.source} -> ${file.target}`, verbose);

    if (copyFile(file.source, file.target, dryRun)) {
      copied++;
    } else {
      errors++;
    }
  }

  return { copied, skipped: 0, errors, total: files.length };
}

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs(args) {
  const options = {
    dryRun: false,
    verbose: false,
    directories: [],
  };

  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('-')) {
      options.directories.push(arg);
    }
  }

  // Default to all sync dirs if none specified
  if (options.directories.length === 0) {
    options.directories = CONFIG.syncDirs;
  }

  return options;
}

function printUsage() {
  console.log(`
Usage: node scripts/sync-history.js [options] [directory...]

Options:
  -n, --dry-run    Show what would be copied without copying
  -v, --verbose    Show detailed output
  -h, --help       Show this help message

Directories (default: all):
  ${CONFIG.syncDirs.join(', ')}

Examples:
  node scripts/sync-history.js                    # Sync all directories
  node scripts/sync-history.js todos debug        # Sync only todos and debug
  node scripts/sync-history.js --dry-run          # Preview changes
`);
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printUsage();
    process.exit(0);
  }

  log.info(`Source: ${CONFIG.sourceBase}`);
  log.info(`Target: ${CONFIG.targetBase}`);

  if (options.dryRun) {
    log.warn('Dry run mode - no files will be copied');
  }

  const results = { totalCopied: 0, totalErrors: 0 };

  for (const dir of options.directories) {
    if (!CONFIG.syncDirs.includes(dir)) {
      log.warn(`Unknown directory: ${dir}, skipping`);
      continue;
    }

    log.info(`Syncing ${dir}...`);
    const result = syncDirectory(dir, options);

    if (result.copied > 0) {
      log.success(`${dir}: ${result.copied} files ${options.dryRun ? 'to copy' : 'copied'}`);
    } else {
      log.info(`${dir}: up to date`);
    }

    results.totalCopied += result.copied;
    results.totalErrors += result.errors;
  }

  console.log('\n--- Summary ---');
  console.log(`Files ${options.dryRun ? 'to copy' : 'copied'}: ${results.totalCopied}`);
  if (results.totalErrors > 0) {
    console.log(`Errors: ${results.totalErrors}`);
  }
}

main();
