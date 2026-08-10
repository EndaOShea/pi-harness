/**
 * Pure path matching for the protected-paths permission policy. The
 * protected-directory list is supplied by the policy module, so this
 * library stays generic and byte-identical across harness forks.
 */

export function expandHome(entry, homeDirectory) {
  if (entry === "~") {
    return homeDirectory;
  }
  if (entry.startsWith("~/")) {
    return `${homeDirectory}/${entry.slice(2)}`;
  }
  return entry;
}

export function findProtectedDirectory(
  absolutePath,
  homeDirectory,
  protectedDirectories,
) {
  for (const entry of protectedDirectories) {
    const directory = expandHome(entry, homeDirectory).replace(/\/+$/, "");
    if (
      absolutePath === directory ||
      absolutePath.startsWith(`${directory}/`)
    ) {
      return entry;
    }
  }
  return null;
}

const PLACEHOLDER_ENV_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

const PRIVATE_KEY_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

export function isSecretFile(absolutePath, homeDirectory) {
  const basename = absolutePath.slice(absolutePath.lastIndexOf("/") + 1);
  // Public keys are public by definition. This exemption precedes every
  // rule below, including the blanket ~/.ssh rule, so routine reads of
  // ~/.ssh/id_rsa.pub do not train approval fatigue.
  if (basename.endsWith(".pub")) {
    return null;
  }
  if (
    absolutePath === `${homeDirectory}/.ssh` ||
    absolutePath.startsWith(`${homeDirectory}/.ssh/`)
  ) {
    return "file under ~/.ssh";
  }
  if (absolutePath === `${homeDirectory}/.aws/credentials`) {
    return "AWS credentials file";
  }
  if (absolutePath === `${homeDirectory}/.pi/agent/auth.json`) {
    return "Pi authentication store";
  }
  if (basename === ".netrc") {
    return "netrc credentials file";
  }
  if (
    (basename === ".env" || basename.startsWith(".env.")) &&
    !PLACEHOLDER_ENV_BASENAMES.has(basename)
  ) {
    return "dotenv file";
  }
  if (PRIVATE_KEY_PREFIXES.some((prefix) => basename.startsWith(prefix))) {
    return "private key file";
  }
  if (basename.endsWith(".pem") || basename.endsWith(".key")) {
    return "private key material";
  }
  return null;
}

function isUnder(absolutePath, prefix) {
  const clean = prefix.replace(/\/+$/, "");
  return absolutePath === clean || absolutePath.startsWith(`${clean}/`);
}

/**
 * True when a path is neither inside the workspace root nor inside any
 * exempt prefix (OS scratch space, pseudo-filesystems). The policy module
 * supplies both lists so this stays generic across forks.
 */
export function isOutsideWorkspace(absolutePath, workspaceRoot, exemptPrefixes) {
  if (isUnder(absolutePath, workspaceRoot)) {
    return false;
  }
  return !exemptPrefixes.some((prefix) => isUnder(absolutePath, prefix));
}

const HOME_PREFIXES = ["~", "$HOME", "${HOME}"];

function expandCommandToken(rawToken, homeDirectory) {
  const token = rawToken.replace(/^["']+|["']+$/g, "");
  if (!token) {
    return "";
  }
  for (const prefix of HOME_PREFIXES) {
    if (token === prefix || token.startsWith(`${prefix}/`)) {
      return homeDirectory + token.slice(prefix.length);
    }
  }
  return token;
}

/**
 * Find shell-command tokens that reference paths outside the workspace
 * root: absolute paths (after home expansion) not under the root or an
 * exempt prefix, and relative paths with a `..` segment, which cannot be
 * proven to stay inside. Purely lexical — a path built dynamically by the
 * command is not visible here; this narrows the escape surface, it does
 * not seal it.
 */
export function findWorkspaceEscapes(
  command, workspaceRoot, homeDirectory, exemptPrefixes,
) {
  const findings = [];
  for (const rawToken of command.split(/[\s;|&<>()=]+/)) {
    const token = expandCommandToken(rawToken, homeDirectory);
    if (!token) {
      continue;
    }
    if (token.startsWith("/")) {
      if (isOutsideWorkspace(token, workspaceRoot, exemptPrefixes)) {
        findings.push({ token: rawToken, path: token });
      }
    } else if (token.includes("/") && token.split("/").includes("..")) {
      findings.push({ token: rawToken, path: token });
    }
  }
  return findings;
}

const UPLOAD_FLAGS = new Set([
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "--data-ascii", "--json", "-F", "--form", "--form-string",
  "-T", "--upload-file",
  "--post-data", "--post-file", "--body-data", "--body-file",
]);

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const NET_PROGRAMS = new Set(["nc", "ncat", "netcat", "socat", "scp", "sftp"]);

const LOCAL_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;

function segmentProgram(tokens) {
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue; // leading VAR=value assignment
    }
    return token;
  }
  return "";
}

/**
 * Find outbound-transmission shapes in a shell command: uploads via
 * curl/wget data flags or mutating HTTP methods (unless every visible URL
 * is local), raw network programs (nc, socat, scp, sftp), rsync to a
 * remote target, and git push. Lexical, like every command matcher here:
 * it narrows the exfiltration surface, it does not seal it.
 */
export function findEgressCommands(command) {
  const findings = [];
  for (const segment of command.split(/[;|&]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    const program = segmentProgram(tokens);
    if (NET_PROGRAMS.has(program)) {
      findings.push({ program, reason: "raw network transfer" });
      continue;
    }
    if (program === "git" && tokens.includes("push")) {
      findings.push({ program: "git push", reason: "remote publication" });
      continue;
    }
    if (program === "rsync") {
      if (tokens.some((t) => /^[^\/=][^=]*@[^=]*:/.test(t) || t.startsWith("rsync://"))) {
        findings.push({ program, reason: "remote file transfer" });
      }
      continue;
    }
    if (program === "curl" || program === "wget" || program === "wget2") {
      const carriesData = tokens.some(
        (t) => UPLOAD_FLAGS.has(t)
          || [...UPLOAD_FLAGS].some((flag) => t.startsWith(`${flag}=`)),
      );
      const mutates = tokens.some(
        (t, i) => (t === "-X" || t === "--request")
          && MUTATING_METHODS.has((tokens[i + 1] ?? "").toUpperCase()),
      );
      if (!carriesData && !mutates) {
        continue;
      }
      const urls = tokens.filter((t) => /^https?:\/\//i.test(t.replace(/^["']|["']$/g, "")));
      const allLocal = urls.length > 0
        && urls.every((u) => LOCAL_URL.test(u.replace(/^["']|["']$/g, "")));
      if (!allLocal) {
        findings.push({ program, reason: "data-carrying HTTP request" });
      }
    }
  }
  return findings;
}

/**
 * Find secret-shaped paths referenced anywhere in a shell command, so the
 * bash tool cannot read what the file tools would gate. Tokens are checked
 * with isSecretFile after home expansion (~, $HOME, ${HOME}); a path the
 * shell would resolve differently is at worst flagged conservatively.
 * Relative references match only through basename rules — a bare
 * `auth.json` outside ~/.pi is not secret-shaped and stays unflagged.
 */
export function findSecretPathReferences(command, homeDirectory) {
  const findings = [];
  for (const rawToken of command.split(/[\s;|&<>()=]+/)) {
    const path = expandCommandToken(rawToken, homeDirectory);
    if (!path) {
      continue;
    }
    const rule = isSecretFile(path, homeDirectory);
    if (rule) {
      findings.push({ token: path, rule });
    }
  }
  return findings;
}
