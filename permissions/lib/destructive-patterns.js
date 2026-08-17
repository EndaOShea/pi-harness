import {
  normalizeEffectiveCommand,
  tokenizeShellCommandSegments,
} from "./path-matchers.js";

/**
 * Fallback detection for destructive operations hidden inside interpreter
 * commands or shell constructs. Direct commands are parsed structurally by
 * @thurstonsand/pi-permissions in confirm-deletions.ts.
 */
function findClosingParenthesis(command, start) {
  let depth = 1;
  let quote = null;

  for (let index = start; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && index + 1 < command.length) {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function doubleQuotedLexicalView(content) {
  let view = "quoted";

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\" && index + 1 < content.length) {
      index += 1;
      continue;
    }
    if (
      character === "$" &&
      content[index + 1] === "(" &&
      content[index + 2] !== "("
    ) {
      const closing = findClosingParenthesis(content, index + 2);
      if (closing !== -1) {
        view += ` $(${shellLexicalView(content.slice(index + 2, closing))})`;
        index = closing;
      }
      continue;
    }
    if (character === "`") {
      let closing = index + 1;
      while (closing < content.length && content[closing] !== "`") {
        if (content[closing] === "\\") closing += 1;
        closing += 1;
      }
      view += ` \`${shellLexicalView(content.slice(index + 1, closing))}\``;
      index = closing;
    }
  }

  return view;
}

function shellLexicalView(command) {
  let view = "";
  let atTokenBoundary = true;
  const commandSubstitutionDepths = [];

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && index + 1 < command.length) {
      view += "xx";
      atTokenBoundary = false;
      index += 1;
      continue;
    }
    if (character === "#" && atTokenBoundary) {
      while (index < command.length && command[index] !== "\n") index += 1;
      view += "\n";
      atTokenBoundary = true;
      continue;
    }
    if (
      character === "$" &&
      command[index + 1] === "(" &&
      command[index + 2] !== "("
    ) {
      view += "$(";
      commandSubstitutionDepths.push(1);
      atTokenBoundary = true;
      index += 1;
      continue;
    }
    if (character === "(") {
      if (commandSubstitutionDepths.length > 0) {
        commandSubstitutionDepths[commandSubstitutionDepths.length - 1] += 1;
      }
      view += character;
      atTokenBoundary = true;
      continue;
    }
    if (character === ")") {
      if (commandSubstitutionDepths.length > 0) {
        const depthIndex = commandSubstitutionDepths.length - 1;
        commandSubstitutionDepths[depthIndex] -= 1;
        if (commandSubstitutionDepths[depthIndex] === 0) {
          commandSubstitutionDepths.pop();
          atTokenBoundary = false;
        } else {
          atTokenBoundary = true;
        }
      } else {
        atTokenBoundary = true;
      }
      view += character;
      continue;
    }
    if (character !== "'" && character !== '"') {
      view += character;
      atTokenBoundary = /[\s;&|<>]/.test(character);
      continue;
    }

    const quote = character;
    let content = "";
    for (index += 1; index < command.length; index += 1) {
      const quotedCharacter = command[index];
      if (quotedCharacter === quote) break;
      if (
        quote === '"' &&
        quotedCharacter === "\\" &&
        index + 1 < command.length
      ) {
        content += quotedCharacter + command[index + 1];
        index += 1;
      } else {
        content += quotedCharacter;
      }
    }
    const isNestedShellCommand =
      /\b(?:bash|sh|zsh|dash|ksh)\b[^\n;&|]*\s-[a-zA-Z]*c(?:\s+(?:--|-[a-zA-Z]+))*\s*$/.test(
        view,
      );
    view += isNestedShellCommand
      ? shellLexicalView(content)
      : content === "/dev/null"
        ? content
        : quote === '"'
          ? doubleQuotedLexicalView(content)
          : "quoted";
    atTokenBoundary = false;
  }

  return view;
}

function suppressDoubleBracketConditions(command) {
  let view = "";
  let inConditional = false;

  for (let index = 0; index < command.length; index += 1) {
    const pair = command.slice(index, index + 2);
    const preceding = command[index - 1] ?? " ";
    const following = command[index + 2] ?? " ";
    if (
      !inConditional && pair === "[[" &&
      /[\s;&|()]/.test(preceding) && /[\s;&|()]/.test(following)
    ) {
      inConditional = true;
      view += "  ";
      index += 1;
      continue;
    }
    if (
      inConditional && pair === "]]" &&
      /[\s;&|()]/.test(preceding) && /[\s;&|()]/.test(following)
    ) {
      inConditional = false;
      view += "  ";
      index += 1;
      continue;
    }
    if (!inConditional) {
      view += command[index];
      continue;
    }

    // Inside `[[ ... ]]`, keep executable command substitutions visible so
    // their redirections are still analyzed, but blank the `>`/`<` operators
    // Bash treats as string/arithmetic comparisons in conditional syntax.
    const character = command[index];
    if (
      character === "$" &&
      command[index + 1] === "(" &&
      command[index + 2] !== "("
    ) {
      const closing = findClosingParenthesis(command, index + 2);
      if (closing !== -1) {
        view += command.slice(index, closing + 1);
        index = closing;
        continue;
      }
      view += "$";
      continue;
    }
    if (character === "`") {
      const closing = command.indexOf("`", index + 1);
      if (closing !== -1) {
        view += command.slice(index, closing + 1);
        index = closing;
        continue;
      }
      view += "`";
      continue;
    }
    view += character === ">" || character === "<" ? " " : character;
  }
  return view;
}

const TRUNCATING_OUTPUT_REDIRECTION = {
  name: "truncating output redirection",
  pattern:
    /(^|[^>])>(?![>&])\|?\s*(?!\/dev\/null(?:[\s;&|]|$))[^\s;&|]+/m,
};

const TEE_OVERWRITE = {
  name: "tee overwrite",
  // Tee requires argv-aware handling; this deliberately never regex-matches.
  pattern: /$a/,
};

const BOUNDED_WRAPPER_OVERFLOW = {
  name: "bounded command wrapper overflow",
  // The effective-command normalizer could not confirm the wrapped program
  // within its token/byte budget, so a deeply wrapped `tee` truncation
  // cannot be ruled out. Fail closed with a conservative fallback rather
  // than skipping the segment. Handled structurally, never regex-matches.
  pattern: /$a/,
};

function hasBoundedWrapperOverflow(command) {
  for (const segmentTokens of tokenizeShellCommandSegments(command)) {
    if (normalizeEffectiveCommand(segmentTokens).overflow) return true;
  }
  return false;
}

function hasTeeOverwrite(command) {
  for (const segmentTokens of tokenizeShellCommandSegments(command)) {
    const normalized = normalizeEffectiveCommand(segmentTokens);
    if (normalized.overflow || normalized.program !== "tee") continue;

    let optionsEnded = false;
    let append = false;
    const targets = [];
    for (let index = 1; index < normalized.tokens.length; index += 1) {
      const token = normalized.tokens[index].replace(/^["']|["']$/g, "");
      if (!optionsEnded && token === "--") {
        optionsEnded = true;
      } else if (!optionsEnded && token === "--append") {
        append = true;
      } else if (!optionsEnded && /^-[^-].*/.test(token)) {
        if (token.slice(1).includes("a")) append = true;
      } else if (!optionsEnded && token.startsWith("--")) {
        // Other long tee options do not change overwrite/append mode.
      } else {
        targets.push(token);
      }
    }
    if (
      !append &&
      targets.some((target) => target !== "-" && target !== "/dev/null")
    ) {
      return true;
    }
  }
  return false;
}

export const DESTRUCTIVE_FALLBACK_PATTERNS = [
  {
    name: "interpreter filesystem deletion",
    pattern:
      /\b(?:python(?:3)?|node|ruby)\b[\s\S]*(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|Path\([^)]*\)\.(?:unlink|rmdir)|(?:fs\.|require\(["'](?:node:)?fs["']\)\.)(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)|FileUtils\.rm_rf|File\.(?:delete|unlink))\b/,
  },
  {
    name: "perl filesystem deletion",
    pattern: /\bperl\b[\s\S]*\b(?:unlink|rmdir|rmtree|remove_tree)\b/,
  },
  {
    name: "nested shell deletion",
    pattern:
      /\b(?:bash|sh|zsh|dash|ksh)\b[^\n;&|]*\s-[a-zA-Z]*c\b[\s\S]*\b(?:rm|rmdir|unlink|shred)\b/,
  },
  {
    name: "xargs deletion",
    pattern: /\bxargs\b[^\n;&|]*(?:\brm\b|\brmdir\b|\bunlink\b|\bshred\b)/,
  },
  {
    name: "rsync deletion",
    pattern: /\brsync\b[^\n;&|]*--delete/,
  },
  {
    name: "dd overwrite",
    pattern: /\bdd\b[^\n;&|]*\bof=(?!\/dev\/)/,
  },
  {
    name: "git stash destruction",
    pattern: /\bgit\b[^\n;&|]*\bstash\s+(?:drop|clear)\b/,
  },
  {
    name: "git forced branch deletion",
    pattern:
      /\bgit\b[^\n;&|]*\bbranch\s+(?:-[a-zA-Z]*D[a-zA-Z]*\b|--delete\b[^\n;&|]*--force\b|--force\b[^\n;&|]*--delete\b)/,
  },
  {
    name: "git forced push",
    pattern:
      /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b)/,
  },
  {
    name: "explicit file truncation",
    pattern:
      /(?:\btruncate\b[^\n;&|]*(?:\s-s\s*0\b|\s--size(?:=|\s+)0\b)|\bcp\b[^\n;&|]*\/dev\/null\b|(?:^|[;&|]\s*)(?::|true)\s*>\s*[^>&])/m,
  },
  TRUNCATING_OUTPUT_REDIRECTION,
  TEE_OVERWRITE,
  BOUNDED_WRAPPER_OVERFLOW,
];

export function findDestructiveFallbacks(command) {
  const lexicalView = shellLexicalView(command);
  const redirectionView = suppressDoubleBracketConditions(lexicalView);
  return DESTRUCTIVE_FALLBACK_PATTERNS.filter((entry) => {
    if (entry === TEE_OVERWRITE) return hasTeeOverwrite(lexicalView);
    if (entry === BOUNDED_WRAPPER_OVERFLOW) {
      return hasBoundedWrapperOverflow(lexicalView);
    }
    return entry.pattern.test(
      entry === TRUNCATING_OUTPUT_REDIRECTION ? redirectionView : command,
    );
  });
}
