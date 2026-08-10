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
    const token = rawToken.replace(/^["']+|["']+$/g, "");
    if (!token) {
      continue;
    }
    let path = token;
    for (const prefix of ["~", "$HOME", "${HOME}"]) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        path = homeDirectory + path.slice(prefix.length);
        break;
      }
    }
    const rule = isSecretFile(path, homeDirectory);
    if (rule) {
      findings.push({ token, rule });
    }
  }
  return findings;
}
