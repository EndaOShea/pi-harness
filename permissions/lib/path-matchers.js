import { posix } from "node:path";

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

const PRIVATE_KEY_SUFFIXES = [
  ".pem", ".key", ".p12", ".pfx", ".ppk", ".jks", ".keystore",
  ".keytab", ".kdbx",
];

// These are dedicated credential/key stores. Broad parents such as
// ~/.config, AppData, and Library/Application Support are intentionally
// excluded so ordinary configuration reads remain usable.
const USER_CREDENTIAL_DIRECTORIES = [
  ".ssh",
  ".gnupg",
  ".password-store",
  ".lpass",
  ".local/share/keyrings",
  ".local/share/kwalletd",
  ".config/sops",
  ".config/age",
  ".config/bitwarden cli",
  ".aws/sso/cache",
  ".aws/cli/cache",
  ".config/gcloud/legacy_credentials",
  "Library/Keychains",
  "Library/Application Support/Bitwarden CLI",
  "AppData/Roaming/gcloud/legacy_credentials",
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Roaming/Microsoft/Protect",
  "AppData/Local/Microsoft/Protect",
  "AppData/Roaming/Microsoft/Vault",
  "AppData/Local/Microsoft/Vault",
  "AppData/Roaming/Bitwarden CLI",
  "AppData/Local/Microsoft/PowerShell/secretmanagement",
];

// Exact files in mixed-purpose directories.
const USER_CREDENTIAL_FILES = [
  ".aws/credentials",
  ".azure/accessTokens.json",
  ".azure/msal_token_cache.json",
  ".azure/msal_token_cache.bin",
  ".kube/config",
  ".terraform.d/credentials.tfrc.json",
  ".config/gcloud/application_default_credentials.json",
  ".config/gcloud/credentials.db",
  ".config/gcloud/access_tokens.db",
  ".config/gh/hosts.yml",
  ".config/hub",
  ".config/doctl/config.yaml",
  ".config/rclone/rclone.conf",
  ".docker/config.json",
  ".pi/agent/auth.json",
  ".cargo/credentials.toml",
  ".cargo/credentials",
  ".gem/credentials",
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".config/pip/pip.conf",
  ".pip/pip.conf",
  ".config/uv/auth.toml",
  ".config/pypoetry/auth.toml",
  ".config/poetry/auth.toml",
  ".composer/auth.json",
  ".config/composer/auth.json",
  ".config/containers/auth.json",
  ".config/helm/registry/config.json",
  ".rclone.conf",
  ".vault-token",
  ".clasprc.json",
  "Library/Application Support/pip/pip.conf",
  "Library/Application Support/pypoetry/auth.toml",
  "Library/Preferences/pypoetry/auth.toml",
  "AppData/Roaming/gcloud/application_default_credentials.json",
  "AppData/Roaming/gcloud/credentials.db",
  "AppData/Roaming/gcloud/access_tokens.db",
  "AppData/Roaming/GitHub CLI/hosts.yml",
  "AppData/Roaming/NuGet/NuGet.Config",
  "AppData/Roaming/PostgreSQL/pgpass.conf",
  "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt",
];

const MIXED_CREDENTIAL_SEARCH_ROOTS = [
  ".aws",
  ".azure",
  ".kube",
  ".terraform.d",
  ".docker",
  ".cargo",
  ".gem",
  ".m2",
  ".gradle",
  ".config/gcloud",
  ".config/gh",
  ".config/pip",
  ".pip",
  ".config/uv",
  ".config/pypoetry",
  ".config/poetry",
  ".composer",
  ".config/composer",
  ".config/containers",
  ".config/helm/registry",
  "Library/Application Support/pip",
  "Library/Application Support/pypoetry",
  "Library/Preferences/pypoetry",
  "AppData/Roaming/gcloud",
  "AppData/Roaming/GitHub CLI",
  "AppData/Roaming/NuGet",
  "AppData/Roaming/PostgreSQL",
  "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine",
];

const CREDENTIAL_BASENAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".my.cnf",
  ".pypirc",
  ".s3cfg",
  ".boto",
  ".htpasswd",
  ".htdigest",
  ".dockerconfigjson",
  "nuget.config",
]);

const HISTORY_BASENAMES = new Set([
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".mysql_history",
  ".psql_history",
  ".rediscli_history",
  ".sqlite_history",
  "consolehost_history.txt",
]);

const SYSTEM_CREDENTIAL_FILES = new Set([
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/security/opasswd",
  "/etc/krb5.keytab",
  "/etc/sssd/sssd.conf",
  "/etc/wpa_supplicant/wpa_supplicant.conf",
  "/etc/ppp/chap-secrets",
  "/etc/ppp/pap-secrets",
  "/etc/samba/smbpasswd",
  "/etc/samba/secrets.tdb",
  "/etc/apt/auth.conf",
  "/etc/mysql/debian.cnf",
  "/etc/master.passwd",
  "/private/etc/master.passwd",
]);

const SYSTEM_CREDENTIAL_DIRECTORIES = [
  "/etc/apt/auth.conf.d",
  "/etc/NetworkManager/system-connections",
  "/etc/wireguard",
  "/etc/openvpn",
  "/etc/ipsec.d/private",
  "/etc/ssl/private",
  "/Library/Keychains",
  "/var/db/dslocal/nodes/Default/users",
  "/private/var/db/dslocal/nodes/Default/users",
  "/var/db/shadow/hash",
  "/private/var/db/shadow/hash",
];

const CHROMIUM_PROFILE_MARKERS = [
  "/.config/google-chrome/",
  "/.config/chromium/",
  "/.config/brave-browser/",
  "/Library/Application Support/Google/Chrome/",
  "/Library/Application Support/Chromium/",
  "/Library/Application Support/BraveSoftware/Brave-Browser/",
  "/AppData/Local/Google/Chrome/User Data/",
  "/AppData/Local/Microsoft/Edge/User Data/",
  "/AppData/Local/BraveSoftware/Brave-Browser/User Data/",
];

const CHROMIUM_SECRET_BASENAMES = new Set([
  "Login Data",
  "Login Data For Account",
  "Cookies",
  "Web Data",
  "Local State",
]);

const FIREFOX_PROFILE_MARKERS = [
  "/.mozilla/firefox/",
  "/Library/Application Support/Firefox/Profiles/",
  "/Library/Application Support/Mozilla/Firefox/Profiles/",
  "/AppData/Roaming/Mozilla/Firefox/Profiles/",
];

const FIREFOX_SECRET_BASENAMES = new Set([
  "logins.json",
  "key3.db",
  "key4.db",
  "cookies.sqlite",
  "formhistory.sqlite",
]);

function isWindowsPath(value) {
  return /^[a-z]:[\\/]/i.test(String(value ?? "")) ||
    /^\\\\/.test(String(value ?? ""));
}

function normalizePolicyPath(value, caseInsensitive = false) {
  const normalized = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  const withoutTrailing = normalized.length > 1
    ? normalized.replace(/\/+$/, "")
    : normalized;
  return caseInsensitive ? withoutTrailing.toLowerCase() : withoutTrailing;
}

function normalizePolicyRule(value, caseInsensitive) {
  return caseInsensitive ? value.toLowerCase() : value;
}

function policySetHas(values, candidate, caseInsensitive) {
  if (!caseInsensitive) {
    return values.has(candidate);
  }
  const lowerCandidate = candidate.toLowerCase();
  return [...values].some((value) => value.toLowerCase() === lowerCandidate);
}

function isNormalizedAtOrUnder(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function sqliteMainBasename(basename) {
  return basename.replace(/-(?:wal|shm|journal)$/, "");
}

function isBrowserCredentialFile(path, basename, caseInsensitive) {
  const mainBasename = sqliteMainBasename(basename);
  if (
    policySetHas(CHROMIUM_SECRET_BASENAMES, mainBasename, caseInsensitive) &&
    CHROMIUM_PROFILE_MARKERS.some((marker) =>
      path.includes(normalizePolicyRule(marker, caseInsensitive)),
    )
  ) {
    return true;
  }
  if (
    policySetHas(FIREFOX_SECRET_BASENAMES, mainBasename, caseInsensitive) &&
    FIREFOX_PROFILE_MARKERS.some((marker) =>
      path.includes(normalizePolicyRule(marker, caseInsensitive)),
    )
  ) {
    return true;
  }
  return path.endsWith(normalizePolicyRule(
    "/Library/Cookies/Cookies.binarycookies", caseInsensitive,
  )) || path.endsWith(normalizePolicyRule(
    "/Library/Safari/Cookies.binarycookies", caseInsensitive,
  )) || path.endsWith(normalizePolicyRule(
    "/Library/Safari/Form Values", caseInsensitive,
  ));
}

function isWindowsSystemCredentialFile(path) {
  const folded = path.toLowerCase();
  return /^[a-z]:\/windows\/system32\/config\/(?:regback\/)?(?:sam|security|system)$/.test(folded) ||
    /^[a-z]:\/windows\/ntds\/ntds\.dit$/.test(folded) ||
    /^[a-z]:\/windows\/(?:panther|system32\/sysprep)\/.*(?:unattend|sysprep).*\.xml$/.test(folded);
}

function isBrowserSearchRoot(path, caseInsensitive) {
  for (const marker of CHROMIUM_PROFILE_MARKERS) {
    const root = normalizePolicyRule(marker.replace(/\/$/, ""), caseInsensitive);
    if (path === root || path.endsWith(root)) {
      return true;
    }
    const offset = path.indexOf(`${root}/`);
    if (offset === -1) {
      continue;
    }
    const remainder = path.slice(offset + root.length + 1);
    const comparable = caseInsensitive ? remainder.toLowerCase() : remainder;
    if (
      /^(?:Default|Profile [^/]+|Guest Profile)(?:\/Network)?$/.test(remainder) ||
      (caseInsensitive && /^(?:default|profile [^/]+|guest profile)(?:\/network)?$/.test(comparable))
    ) {
      return true;
    }
  }
  for (const marker of FIREFOX_PROFILE_MARKERS) {
    const root = normalizePolicyRule(marker.replace(/\/$/, ""), caseInsensitive);
    if (path === root || path.endsWith(root)) {
      return true;
    }
    const offset = path.indexOf(`${root}/`);
    if (offset === -1) {
      continue;
    }
    const remainder = path.slice(offset + root.length + 1);
    if (remainder && !remainder.includes("/")) {
      return true;
    }
  }
  return path.endsWith(normalizePolicyRule("/Library/Safari", caseInsensitive)) ||
    path.endsWith(normalizePolicyRule("/Library/Cookies", caseInsensitive));
}

/** Return a mixed-purpose directory that should be approval-gated when used
 * as a recursive search target, without gating ordinary files within it. */
export function findCredentialSearchRoot(absolutePath, homeDirectory) {
  const caseInsensitive = isWindowsPath(absolutePath) || isWindowsPath(homeDirectory);
  const path = normalizePolicyPath(absolutePath, caseInsensitive);
  const home = normalizePolicyPath(homeDirectory, caseInsensitive);
  for (const relative of MIXED_CREDENTIAL_SEARCH_ROOTS) {
    if (path === normalizePolicyPath(`${home}/${relative}`, caseInsensitive)) {
      return `mixed credential directory (${relative})`;
    }
  }
  if (isBrowserSearchRoot(path, caseInsensitive)) {
    return "browser profile directory";
  }
  return null;
}

export function isSecretFile(absolutePath, homeDirectory) {
  const caseInsensitive = isWindowsPath(absolutePath) || isWindowsPath(homeDirectory);
  const path = normalizePolicyPath(absolutePath, caseInsensitive);
  const home = normalizePolicyPath(homeDirectory, caseInsensitive);
  const basename = path.slice(path.lastIndexOf("/") + 1);

  // Public keys are public by definition. This exemption precedes directory
  // and host-key rules so routine public-key reads do not train approval
  // fatigue.
  if (basename.endsWith(".pub")) {
    return null;
  }

  for (const relative of USER_CREDENTIAL_DIRECTORIES) {
    const root = normalizePolicyPath(`${home}/${relative}`, caseInsensitive);
    if (isNormalizedAtOrUnder(path, root)) {
      return `credential store (${relative})`;
    }
  }
  for (const relative of USER_CREDENTIAL_FILES) {
    if (path === normalizePolicyPath(`${home}/${relative}`, caseInsensitive)) {
      return `credential file (${relative})`;
    }
  }
  if (policySetHas(CREDENTIAL_BASENAMES, basename, caseInsensitive)) {
    return `credential or package-registry file (${basename})`;
  }
  if (policySetHas(HISTORY_BASENAMES, basename, caseInsensitive)) {
    return `shell/database history (${basename})`;
  }
  if ([...SYSTEM_CREDENTIAL_FILES].some(
    (entry) => path === normalizePolicyRule(entry, caseInsensitive),
  )) {
    return `system credential file (${path})`;
  }
  if (
    SYSTEM_CREDENTIAL_DIRECTORIES.some((root) =>
      isNormalizedAtOrUnder(
        path, normalizePolicyRule(root, caseInsensitive),
      ),
    )
  ) {
    return `system credential store (${path})`;
  }
  if (isWindowsSystemCredentialFile(path)) {
    return `Windows credential/system hive (${path})`;
  }
  if (isBrowserCredentialFile(path, basename, caseInsensitive)) {
    return `browser credential/session store (${basename})`;
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
  if (
    PRIVATE_KEY_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
    (basename.startsWith("ssh_host_") && basename.endsWith("_key"))
  ) {
    return "private key or credential container";
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
  const normalizedPath = posix.normalize(absolutePath);
  const normalizedRoot = posix.normalize(workspaceRoot);
  if (isUnder(normalizedPath, normalizedRoot)) {
    return false;
  }
  return !exemptPrefixes.some((prefix) =>
    isUnder(normalizedPath, posix.normalize(prefix))
  );
}

function commandTokens(command) {
  return command.match(/"[^"]*"|'[^']*'|[^\s;|&<>()=]+/g) ?? [];
}

export function tokenizeShellCommandSegments(command) {
  const segments = [];
  let tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;

  const finishToken = () => {
    if (token) {
      tokens.push(token);
      token = "";
    }
  };
  const finishSegment = () => {
    finishToken();
    if (tokens.length > 0) {
      segments.push(tokens);
      tokens = [];
    }
  };

  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      token += character;
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      token += character;
    } else if (/[;|&]/.test(character)) {
      finishSegment();
    } else if (/\s/.test(character) || /[<>()]/.test(character)) {
      finishToken();
    } else {
      token += character;
    }
  }
  if (escaped) {
    token += "\\";
  }
  finishSegment();
  return segments;
}

function executableName(token) {
  return stripBalancedOuterQuotes(token).split(/[\\/]/).pop() ?? "";
}

function stripBalancedOuterQuotes(rawToken) {
  const first = rawToken[0];
  return rawToken.length >= 2 &&
      (first === '"' || first === "'") &&
      rawToken.at(-1) === first
    ? rawToken.slice(1, -1)
    : rawToken;
}

const NESTED_COMMAND_MAX_DEPTH = 4;
const NESTED_COMMAND_MAX_INPUT = 64 * 1024;
const NESTED_COMMAND_MAX_VIEWS = 32;
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

function commandSubstitutionPayloads(command) {
  const payloads = [];
  let quote = "";
  let malformed = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? "" : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? "" : '"';
      continue;
    }
    if (quote === "'") continue;

    if (character === "`") {
      const payloadStart = index + 1;
      let closing = -1;
      for (let cursor = payloadStart; cursor < command.length; cursor += 1) {
        if (command[cursor] === "\\") {
          cursor += 1;
        } else if (command[cursor] === "`") {
          closing = cursor;
          break;
        }
      }
      if (closing === -1) {
        malformed = true;
        break;
      }
      payloads.push(command.slice(payloadStart, closing));
      index = closing;
      continue;
    }

    if (
      character !== "$" ||
      command[index + 1] !== "(" ||
      command[index + 2] === "("
    ) {
      continue;
    }

    const payloadStart = index + 2;
    let depth = 1;
    let innerQuote = "";
    let inBackticks = false;
    let closing = -1;
    for (let cursor = payloadStart; cursor < command.length; cursor += 1) {
      const inner = command[cursor];
      if (inner === "\\" && innerQuote !== "'") {
        cursor += 1;
        continue;
      }
      if (inner === "`" && innerQuote !== "'") {
        inBackticks = !inBackticks;
        continue;
      }
      if (inBackticks) continue;
      if (inner === "'" && innerQuote !== '"') {
        innerQuote = innerQuote === "'" ? "" : "'";
        continue;
      }
      if (inner === '"' && innerQuote !== "'") {
        innerQuote = innerQuote === '"' ? "" : '"';
        continue;
      }
      if (innerQuote) continue;
      if (inner === "(") depth += 1;
      if (inner === ")") {
        depth -= 1;
        if (depth === 0) {
          closing = cursor;
          break;
        }
      }
    }
    if (closing === -1) {
      malformed = true;
      break;
    }
    payloads.push(command.slice(payloadStart, closing));
    index = closing;
  }
  return { payloads, malformed };
}

function shellCommandPayloads(command) {
  const payloads = [];
  for (const tokens of tokenizeShellCommandSegments(command)) {
    const normalized = unwrapCommand(tokens);
    if (!SHELL_INTERPRETERS.has(normalized.program)) continue;
    for (let index = 1; index < normalized.tokens.length; index += 1) {
      if (!/^-[A-Za-z]*c[A-Za-z]*$/.test(normalized.tokens[index])) continue;
      let payloadIndex = index + 1;
      if (normalized.tokens[payloadIndex] === "--") payloadIndex += 1;
      const payload = stripBalancedOuterQuotes(
        normalized.tokens[payloadIndex] ?? "",
      );
      if (payload) payloads.push(payload);
      break;
    }
  }
  return payloads;
}

/**
 * Analyze the bounded set of command strings that the shell will visibly
 * execute: the outer command, recognized shell `-c` payloads, `$()`
 * substitutions, and backtick substitutions. Limits are reported rather
 * than silently dropping executable text so security policies can fail closed.
 */
export function analyzeExecutableCommandViews(command) {
  const raw = String(command ?? "");
  const root = raw.slice(0, NESTED_COMMAND_MAX_INPUT);
  const analysis = {
    views: [],
    inputTruncated: raw.length > NESTED_COMMAND_MAX_INPUT,
    payloadTruncated: false,
    depthExceeded: false,
    viewLimitExceeded: false,
    malformedSubstitution: false,
  };
  const admitted = new Set();
  const queue = [];

  const admit = (payload, depth) => {
    if (!payload) return;
    const visible = payload.slice(0, NESTED_COMMAND_MAX_INPUT);
    if (payload.length > NESTED_COMMAND_MAX_INPUT) {
      analysis.payloadTruncated = true;
    }
    if (!visible || admitted.has(visible)) return;
    if (admitted.size >= NESTED_COMMAND_MAX_VIEWS) {
      analysis.viewLimitExceeded = true;
      return;
    }
    admitted.add(visible);
    queue.push({ command: visible, depth });
  };

  admit(root, 0);
  while (queue.length > 0) {
    const current = queue.shift();
    analysis.views.push(current.command);
    const substitutions = commandSubstitutionPayloads(current.command);
    if (substitutions.malformed) analysis.malformedSubstitution = true;
    const nested = [
      ...shellCommandPayloads(current.command),
      ...substitutions.payloads,
    ];
    if (current.depth >= NESTED_COMMAND_MAX_DEPTH) {
      if (nested.length > 0) analysis.depthExceeded = true;
      continue;
    }
    for (const payload of nested) admit(payload, current.depth + 1);
  }
  return analysis;
}

export function findExecutableCommandViews(command) {
  return analyzeExecutableCommandViews(command).views;
}

function commandAnalysisExceeded(analysis) {
  return analysis.inputTruncated || analysis.payloadTruncated ||
    analysis.depthExceeded || analysis.viewLimitExceeded ||
    analysis.malformedSubstitution;
}

const COMMAND_ANALYSIS_LIMIT_REASON =
  "executable command expansion exceeded safety bounds";

function expandCommandToken(rawToken, homeDirectory) {
  const token = stripBalancedOuterQuotes(rawToken);
  if (!token) {
    return "";
  }

  const roots = [
    ["${env:LOCALAPPDATA}", `${homeDirectory}/AppData/Local`, true],
    ["$env:LOCALAPPDATA", `${homeDirectory}/AppData/Local`, true],
    ["%LOCALAPPDATA%", `${homeDirectory}/AppData/Local`, true],
    ["${env:APPDATA}", `${homeDirectory}/AppData/Roaming`, true],
    ["$env:APPDATA", `${homeDirectory}/AppData/Roaming`, true],
    ["%APPDATA%", `${homeDirectory}/AppData/Roaming`, true],
    ["${env:USERPROFILE}", homeDirectory, true],
    ["$env:USERPROFILE", homeDirectory, true],
    ["%USERPROFILE%", homeDirectory, true],
    ["${XDG_CONFIG_HOME}", `${homeDirectory}/.config`, false],
    ["$XDG_CONFIG_HOME", `${homeDirectory}/.config`, false],
    ["${HOME}", homeDirectory, false],
    ["$HOME", homeDirectory, false],
    ["~", homeDirectory, false],
  ];

  const windowsShell = isWindowsPath(homeDirectory);
  const lowerToken = token.toLowerCase();
  for (const [prefix, root, alwaysCaseInsensitive] of roots) {
    const caseInsensitive = alwaysCaseInsensitive ||
      (windowsShell && prefix !== "~");
    const prefixMatches = caseInsensitive
      ? lowerToken.startsWith(prefix.toLowerCase())
      : token.startsWith(prefix);
    const following = token.slice(prefix.length, prefix.length + 1);
    if (
      prefixMatches &&
      (token.length === prefix.length || following === "/" || following === "\\")
    ) {
      return root + token.slice(prefix.length);
    }
  }
  return token;
}

const CONTENT_SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg"]);

/**
 * Extract visible positional path candidates from shell command segments.
 * This is intentionally lexical: policies can resolve the returned paths
 * through the filesystem, while this pure matcher never touches it.
 */
export function findShellPathCandidates(command, homeDirectory) {
  const findings = [];
  const analysis = analyzeExecutableCommandViews(command);
  for (const view of analysis.views) {
    for (const tokens of tokenizeShellCommandSegments(view)) {
      let programIndex = 0;
      while (
        programIndex < tokens.length &&
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[programIndex])
      ) {
        programIndex += 1;
      }
      if (programIndex >= tokens.length) continue;

      const program = executableName(tokens[programIndex]);
      const searchProgram = CONTENT_SEARCH_PROGRAMS.has(program);
      const recursiveSearch = program === "rg" || tokens.some((rawToken) => {
        const token = stripBalancedOuterQuotes(rawToken);
        return token === "--recursive" || /^-[^-]*[rR]/.test(token);
      });
      let positionalIndex = 0;

      for (let index = programIndex + 1; index < tokens.length; index += 1) {
        const rawToken = tokens[index];
        let candidate = rawToken;
        const unquoted = stripBalancedOuterQuotes(rawToken);
        const optionValue = unquoted.match(/^--[^=]+=(.+)$/s);
        if (optionValue) {
          candidate = optionValue[1];
        } else if (unquoted.startsWith("-") && unquoted !== "-") {
          continue;
        }

        const path = expandCommandToken(candidate, homeDirectory);
        if (!path) continue;
        findings.push({
          path,
          token: rawToken,
          contentSearch: searchProgram && recursiveSearch && positionalIndex > 0,
        });
        positionalIndex += 1;
      }
    }
  }
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.path}\0${finding.contentSearch}`, finding);
  }
  return [...unique.values()];
}

/**
 * Find shell-command tokens that reference paths outside the workspace
 * root: normalized absolute paths (after home expansion) not under the
 * root or an exempt prefix, and relative paths with a `..` segment,
 * including a bare `..`. Purely lexical — a path built dynamically by the
 * command is not visible here; this narrows the escape surface, it does
 * not seal it.
 */
export function findWorkspaceEscapes(
  command, workspaceRoot, homeDirectory, exemptPrefixes,
) {
  const findings = [];
  const analysis = analyzeExecutableCommandViews(command);
  for (const candidate of findShellPathCandidates(command, homeDirectory)) {
    const token = candidate.path;
    if (token.startsWith("/")) {
      const normalized = posix.normalize(token);
      if (isOutsideWorkspace(normalized, workspaceRoot, exemptPrefixes)) {
        findings.push({ token: candidate.token, path: normalized });
      }
    } else if (token.split("/").includes("..")) {
      findings.push({ token: candidate.token, path: token });
    }
  }
  if (commandAnalysisExceeded(analysis)) {
    findings.push({
      token: "<bounded command analysis>",
      path: COMMAND_ANALYSIS_LIMIT_REASON,
    });
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

const NET_PROGRAMS = new Set([
  "nc", "ncat", "netcat", "socat", "scp", "sftp", "ssh",
]);

/**
 * An rsync operand naming a remote host, by rsync's own rule: a colon
 * before any slash makes the operand remote, whether or not a user is
 * given. The previous form required `user@host:` and let the equally
 * valid `host:/dest` transfer off the machine ungated.
 *
 * Leading `-` excludes options, and excluding `=` and `/` before the colon
 * keeps `--out-format=%f:%l` and a local path that merely contains a colon
 * (`src/a:b`) from matching. `host::module` daemon syntax matches on its
 * first colon.
 */
const RSYNC_REMOTE_TARGET = /^[^-\/=][^\/=]*:/;

const LOCAL_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;
const CURL_SHORT_OPTIONS_WITH_VALUES = new Set([
  "A", "b", "c", "d", "D", "e", "E", "F", "H", "K", "m", "o",
  "P", "Q", "r", "t", "T", "u", "U", "w", "x", "X", "Y", "y", "z",
]);

function curlShortClusterCarriesData(token) {
  if (!/^-[^-].*/s.test(token)) return false;
  const cluster = token.slice(1);
  for (let index = 0; index < cluster.length; index += 1) {
    const option = cluster[index];
    if (!CURL_SHORT_OPTIONS_WITH_VALUES.has(option)) continue;
    return option === "d" || option === "F" || option === "T";
  }
  return false;
}

function executableBasename(token) {
  return token.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";
}

const ENV_NO_ARGUMENT_OPTIONS = new Set([
  "-i", "--ignore-environment", "-0", "--null", "--debug", "-v",
  "--list-signal-handling",
]);
const ENV_ARGUMENT_OPTIONS = new Set([
  "-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string",
]);
const EFFECTIVE_COMMAND_MAX_TOKENS = 256;
const EFFECTIVE_COMMAND_MAX_BYTES = 64 * 1024;

function splitStringTokens(value) {
  return tokenizeShellCommandSegments(stripBalancedOuterQuotes(value)).flat();
}

function chargeEffectiveCommandBudget(budget, token) {
  budget.tokens += 1;
  budget.bytes += String(token ?? "").length;
  if (
    budget.tokens > EFFECTIVE_COMMAND_MAX_TOKENS ||
    budget.bytes > EFFECTIVE_COMMAND_MAX_BYTES
  ) {
    budget.exceeded = true;
    return false;
  }
  return true;
}

function parseEnvWrapper(envTokens, budget) {
  const args = envTokens.slice(1);
  let index = 0;

  while (index < args.length) {
    const token = stripBalancedOuterQuotes(args[index]);
    if (!chargeEffectiveCommandBudget(budget, token)) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "-") {
      index += 1;
      continue;
    }
    if (token === "--") {
      index += 1;
      break;
    }
    if (ENV_NO_ARGUMENT_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (/^--(?:block|default|ignore)-signal(?:=|$)/s.test(token)) {
      index += 1;
      continue;
    }
    if (/^--(?:unset|chdir)=/s.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--split-string=")) {
      const split = splitStringTokens(token.slice(token.indexOf("=") + 1));
      args.splice(index, 1, ...split);
      continue;
    }
    if (ENV_ARGUMENT_OPTIONS.has(token)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { childTokens: [], hasChild: false, overflow: false };
      }
      if (!chargeEffectiveCommandBudget(budget, value)) break;
      if (token === "-S" || token === "--split-string") {
        const split = splitStringTokens(value);
        args.splice(index, 2, ...split);
        continue;
      }
      index += 2;
      continue;
    }
    if (/^-[^-]{2,}/s.test(token)) {
      const cluster = token.slice(1);
      let recognized = true;
      let consumed = 1;
      let split = null;
      for (let optionIndex = 0; optionIndex < cluster.length; optionIndex += 1) {
        const option = cluster[optionIndex];
        if (option === "i" || option === "0" || option === "v") continue;
        if (!"uCPS".includes(option)) {
          recognized = false;
          break;
        }
        const attached = cluster.slice(optionIndex + 1);
        const value = attached || args[index + 1];
        if (value === undefined) {
          return { childTokens: [], hasChild: false, overflow: false };
        }
        if (!attached) {
          consumed += 1;
          if (!chargeEffectiveCommandBudget(budget, value)) break;
        }
        if (option === "S") split = splitStringTokens(value);
        break;
      }
      if (budget.exceeded) break;
      if (recognized) {
        if (split) {
          args.splice(index, consumed, ...split);
        } else {
          index += consumed;
        }
        continue;
      }
    }
    break;
  }

  if (budget.exceeded) {
    return { childTokens: [], hasChild: false, overflow: true };
  }
  const childTokens = args.slice(index);
  return {
    childTokens,
    hasChild: childTokens.length > 0,
    overflow: false,
  };
}

export function normalizeEffectiveCommand(tokens) {
  let working = tokens.slice();
  const budget = { tokens: 0, bytes: 0, exceeded: false };

  while (working.length > 0) {
    while (
      working.length > 0 &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(
        stripBalancedOuterQuotes(working[0]),
      )
    ) {
      if (!chargeEffectiveCommandBudget(budget, working[0])) {
        return { program: "", tokens: [], overflow: true };
      }
      working = working.slice(1);
    }
    if (working.length === 0) {
      return { program: "", tokens: [], overflow: false };
    }
    if (!chargeEffectiveCommandBudget(budget, working[0])) {
      return { program: "", tokens: [], overflow: true };
    }

    const program = executableBasename(working[0]);
    if (program === "env") {
      const envTokens = working;
      const parsed = parseEnvWrapper(envTokens, budget);
      if (parsed.overflow) {
        return { program: "", tokens: [], overflow: true };
      }
      if (!parsed.hasChild) {
        return {
          program: "env",
          tokens: envTokens,
          environmentDump: true,
          overflow: false,
        };
      }
      working = parsed.childTokens;
      continue;
    }
    if (program === "command") {
      const commandTokens = working;
      working = working.slice(1);
      while (working.length > 0) {
        const option = stripBalancedOuterQuotes(working[0]);
        if (option === "--") {
          chargeEffectiveCommandBudget(budget, option);
          working = working.slice(1);
          break;
        }
        if (!/^-[pVv]+$/.test(option)) break;
        if (!chargeEffectiveCommandBudget(budget, option)) {
          return { program: "", tokens: [], overflow: true };
        }
        if (/[Vv]/.test(option)) {
          return {
            program: "command",
            tokens: commandTokens,
            environmentDump: false,
            overflow: false,
          };
        }
        working = working.slice(1);
      }
      continue;
    }
    return {
      program,
      tokens: working,
      environmentDump: false,
      overflow: false,
    };
  }
  return { program: "", tokens: [], overflow: false };
}

function unwrapCommand(tokens) {
  return normalizeEffectiveCommand(tokens);
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
  const analysis = analyzeExecutableCommandViews(command);
  for (const view of analysis.views) {
    for (const rawTokens of tokenizeShellCommandSegments(view)) {
      if (rawTokens.length === 0) continue;
      const normalizedCommand = unwrapCommand(rawTokens);
      if (normalizedCommand.overflow) {
        findings.push({
          program: "command wrapper",
          reason: COMMAND_ANALYSIS_LIMIT_REASON,
        });
        continue;
      }
      const { program, tokens } = normalizedCommand;
      const normalizedTokens = tokens.map(stripBalancedOuterQuotes);
      if (NET_PROGRAMS.has(program)) {
        findings.push({ program, reason: "raw network transfer" });
        continue;
      }
      if (program === "git" && normalizedTokens.includes("push")) {
        findings.push({ program: "git push", reason: "remote publication" });
        continue;
      }
      if (program === "rsync") {
        if (normalizedTokens.some((token) =>
          RSYNC_REMOTE_TARGET.test(token) || token.startsWith("rsync://")
        )) {
          findings.push({ program, reason: "remote file transfer" });
        }
        continue;
      }
      if (program !== "curl" && program !== "wget" && program !== "wget2") {
        continue;
      }

      const carriesData = normalizedTokens.some((token) =>
        UPLOAD_FLAGS.has(token) ||
        [...UPLOAD_FLAGS].some((flag) => token.startsWith(`${flag}=`)) ||
        (program === "curl" && curlShortClusterCarriesData(token))
      );
      const mutates = normalizedTokens.some((token, index) =>
        ((token === "-X" || token === "--request") &&
          MUTATING_METHODS.has((normalizedTokens[index + 1] ?? "").toUpperCase())) ||
        /^-X(?:POST|PUT|PATCH|DELETE)$/i.test(token) ||
        /^--request=(?:POST|PUT|PATCH|DELETE)$/i.test(token) ||
        ((program === "wget" || program === "wget2") &&
          ((token === "--method" &&
            MUTATING_METHODS.has((normalizedTokens[index + 1] ?? "").toUpperCase())) ||
           /^--method=(?:POST|PUT|PATCH|DELETE)$/i.test(token)))
      );
      if (!carriesData && !mutates) continue;

      const urls = [];
      for (let index = 0; index < normalizedTokens.length; index += 1) {
        const token = normalizedTokens[index];
        if (/^https?:\/\//i.test(token)) {
          urls.push(token);
        } else if (token === "--url" && normalizedTokens[index + 1]) {
          urls.push(normalizedTokens[index + 1]);
          index += 1;
        } else if (/^--url=["']?https?:\/\//i.test(token)) {
          urls.push(stripBalancedOuterQuotes(token.slice("--url=".length)));
        }
      }
      const allLocal = urls.length > 0 && urls.every((url) => LOCAL_URL.test(url));
      if (!allLocal) {
        findings.push({ program, reason: "data-carrying HTTP request" });
      }
    }
  }
  if (commandAnalysisExceeded(analysis)) {
    findings.push({
      program: "shell expansion",
      reason: COMMAND_ANALYSIS_LIMIT_REASON,
    });
  }
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.program}\0${finding.reason}`, finding);
  }
  return [...unique.values()];
}

/** Find commands that print the shell environment into model context. */
export function findEnvironmentExposureCommands(command) {
  const findings = [];
  const analysis = analyzeExecutableCommandViews(command);
  for (const view of analysis.views) {
    for (const rawTokens of tokenizeShellCommandSegments(view)) {
      if (rawTokens.length === 0) continue;
      const normalized = unwrapCommand(rawTokens);
      if (normalized.overflow) {
        findings.push({
          program: "command wrapper",
          reason: COMMAND_ANALYSIS_LIMIT_REASON,
        });
        continue;
      }
      const tokens = normalized.tokens.map(stripBalancedOuterQuotes);
      const bareEnvironmentDump = normalized.environmentDump ||
        (normalized.program === "printenv" &&
          (tokens.length === 1 ||
           (tokens.length === 2 && (tokens[1] === "-0" || tokens[1] === "--null")))) ||
        (normalized.program === "set" && tokens.length === 1);
      const exportArguments = normalized.program === "export" &&
          tokens.at(-1) === "--"
        ? tokens.slice(0, -1)
        : tokens;
      const exportedEnvironmentDump = normalized.program === "export" &&
        (exportArguments.length === 1 ||
         (exportArguments.length === 2 && exportArguments[1] === "-p"));
      if (bareEnvironmentDump || exportedEnvironmentDump) {
        findings.push({
          program: normalized.program,
          reason: "environment variable exposure",
        });
      }
    }
  }
  if (commandAnalysisExceeded(analysis)) {
    findings.push({
      program: "shell expansion",
      reason: COMMAND_ANALYSIS_LIMIT_REASON,
    });
  }
  const unique = new Map();
  for (const finding of findings) unique.set(finding.program, finding);
  return [...unique.values()];
}

/**
 * Find secret-shaped paths referenced anywhere in a shell command, so the
 * bash tool cannot read what the file tools would gate. Tokens are checked
 * with isSecretFile after POSIX, cmd.exe, and PowerShell home/application-
 * data expansion; a path the shell would resolve differently is at worst
 * flagged conservatively.
 * Relative references match only through basename rules — a bare
 * `auth.json` outside ~/.pi is not secret-shaped and stays unflagged.
 */
export function findSecretPathReferences(command, homeDirectory) {
  const findings = [];
  const analysis = analyzeExecutableCommandViews(command);
  for (const view of analysis.views) {
    for (const rawToken of commandTokens(view)) {
      const path = expandCommandToken(rawToken, homeDirectory);
      if (!path) continue;
      const rule = isSecretFile(path, homeDirectory);
      if (rule) findings.push({ token: path, rule });
    }
  }
  if (commandAnalysisExceeded(analysis)) {
    findings.push({
      token: "<bounded command analysis>",
      rule: COMMAND_ANALYSIS_LIMIT_REASON,
    });
  }
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.token}\0${finding.rule}`, finding);
  }
  return [...unique.values()];
}

const SENSITIVE_REGISTRY_PREFIXES = [
  "hkey_local_machine\\sam",
  "hkey_local_machine\\security",
  "hkey_local_machine\\system\\currentcontrolset\\control\\lsa",
  "hkey_local_machine\\software\\microsoft\\windows nt\\currentversion\\winlogon",
];

function normalizeRegistryCommand(command) {
  return command.toLowerCase()
    .replace(/registry::/g, "")
    .replace(/\//g, "\\")
    .replace(/\bhklm:(?=\\)/g, "hkey_local_machine")
    .replace(/\bhklm(?=\\)/g, "hkey_local_machine")
    .replace(/\\{2,}/g, "\\");
}

function containsRegistryPrefix(command, prefix) {
  let offset = command.indexOf(prefix);
  while (offset !== -1) {
    const preceding = command.slice(Math.max(0, offset - 1), offset);
    const following = command.slice(offset + prefix.length, offset + prefix.length + 1);
    const validStart = !preceding || /[\\\s"'`(=]/.test(preceding);
    const validEnd = !following || following === "\\" || /[\s"'`)]/.test(following);
    if (validStart && validEnd) {
      return true;
    }
    offset = command.indexOf(prefix, offset + 1);
  }
  return false;
}

/**
 * Find visible reads of Windows Registry locations that hold credential or
 * security-secret material. General Registry queries remain usable; only
 * known sensitive prefixes are matched.
 */
export function findSensitiveRegistryReferences(command) {
  const findings = [];
  const analysis = analyzeExecutableCommandViews(command);
  for (const view of analysis.views) {
    for (const segment of view.split(/[;&|]+/)) {
      const hasRegistryRead = /\breg(?:\.exe)?\s+(?:query|save|export)\b/i.test(segment) ||
        /\bget-(?:item|childitem|itemproperty|itempropertyvalue)\b/i.test(segment);
      if (!hasRegistryRead) continue;
      const normalized = normalizeRegistryCommand(segment);
      for (const key of SENSITIVE_REGISTRY_PREFIXES) {
        if (containsRegistryPrefix(normalized, key)) {
          findings.push({ key, rule: "sensitive Windows Registry key" });
        }
      }
    }
  }
  if (commandAnalysisExceeded(analysis)) {
    findings.push({
      key: "<bounded command analysis>",
      rule: COMMAND_ANALYSIS_LIMIT_REASON,
    });
  }
  const unique = new Map();
  for (const finding of findings) unique.set(finding.key, finding);
  return [...unique.values()];
}
