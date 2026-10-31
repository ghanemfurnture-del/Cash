import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Directories and files to ignore
const IGNORED_PATHS = [
  'node_modules',
  '.git',
  'dist',
  'package-lock.json',
  '.system_generated',
  '.env.local', // Local dev file explicitly permitted on disk, but MUST NOT be tracked in git
  'scripts/scan-secrets.js', // The scanner itself contains the regex patterns
  'scripts\\scan-secrets.js',
];

// Patterns that identify hardcoded secrets
const SUSPICIOUS_PATTERNS = [
  // 1. General JWT tokens starting with eyJ
  /\beyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\b/,
  // 2. Supabase secret service role keys / sb_secret_ pattern
  /\bsb_secret_[a-zA-Z0-9_\-]{16,}\b/,
  // 3. Supabase Personal Access Tokens (sbp_ pattern)
  /\bsbp_[a-zA-Z0-9_\-]{16,}\b/,
  // 4. RSA / Private keys
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  // 5. Database connection string with raw password
  /postgres(?:ql)?:\/\/[a-zA-Z0-9_]+:[^@\s]{4,}@[a-zA-Z0-9.\-_]+/,
];

function checkGitTrackedEnvFiles() {
  try {
    const trackedEnv = execSync('git ls-files .env*', { encoding: 'utf-8' }).trim();
    const trackedLines = trackedEnv.split('\n').filter(Boolean);
    const violating = trackedLines.filter((file) => file !== '.env.example');
    if (violating.length > 0) {
      console.error(`[SECRET SCAN FAILURE] Git is tracking prohibited env files: ${violating.join(', ')}`);
      return violating.length;
    }
  } catch (err) {
    // If git command fails or not in git repo, proceed with file scan
  }
  return 0;
}

function scanDirectory(dir) {
  let issues = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(process.cwd(), fullPath);

    if (IGNORED_PATHS.some((p) => relativePath === p || relativePath.startsWith(p) || entry.name === p)) {
      continue;
    }

    if (entry.isDirectory()) {
      issues += scanDirectory(fullPath);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check for suspicious patterns
      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(content)) {
          console.error(`[SECRET SCAN FAILURE] Potential secret detected in ${relativePath} matching pattern ${pattern}`);
          issues++;
        }
      }
    }
  }

  return issues;
}

console.log('Running secret scanner across workspace...');
let totalIssues = checkGitTrackedEnvFiles();
totalIssues += scanDirectory(process.cwd());

if (totalIssues > 0) {
  console.error(`Secret scan FAILED with ${totalIssues} issue(s).`);
  process.exit(1);
} else {
  console.log('Secret scan PASSED: 0 secrets detected. Workspace and repository are clean.');
  process.exit(0);
}
