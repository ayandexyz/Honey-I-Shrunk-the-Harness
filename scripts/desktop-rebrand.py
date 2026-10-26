#!/usr/bin/env python3
"""Rename the desktop app's on-screen "Jcode" text to "Honey", reversibly.

apps/desktop is a git subtree of upstream jcode-desktop. Renaming ~200 UI
strings by hand would make most `git subtree pull`s conflict, so the rename is
mechanical and invertible instead:

    python3 scripts/desktop-rebrand.py revert   # back to upstream's wording
    git commit -am "desktop: revert Honey rebrand for upstream pull"
    git subtree pull --prefix=apps/desktop jcode-desktop-upstream main -m "..."
    python3 scripts/desktop-rebrand.py apply    # Honey again, incl. new strings
    git commit -am "desktop: re-apply Honey rebrand"

Only Rust string literals are touched, and only ones that read as text: a
literal that also names a path, file, release asset, updater id or a heading
the changelog parser matches (see SKIP) keeps "Jcode", because changing it
would break lookups rather than labels. Whole word, capitalised only, so
lowercase ids (`jcode` provider, binary, env vars) never change.

`revert` relies on upstream never saying "Honey" in a string (checked
2026-10-26). New freecode-owned strings that should say Honey must therefore
not live under apps/desktop, or they will be reverted too.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "apps" / "desktop"
# A literal is left alone when "Jcode" in it is part of a path, file name,
# release asset or id, or a heading the changelog parser matches.
SKIP = re.compile(
    r"[/\\]\s*(Jcode|Honey)\b"           # …/Application Support/Jcode
    r"|\b(Jcode|Honey)\s*[/\\]"          # Jcode.app/…, Jcode/…
    r"|\b(Jcode|Honey)\.(app|png|exe)\b"  # bundle and file names
    r"|\b(Jcode|Honey)-"                  # Jcode-0.5.1-linux…, Jcode-Desktop-Updater
    r"|###"                                # changelog headings
    r"|^b?r?#*\"\s*[\[{]"                 # JSON fixtures: server data, not labels
    r"|\b(Jcode|Honey) subscription\b"    # Jcode's paid plan, matched by name
    r"|\b(Jcode|Honey) Cloud\b"           # Jcode's hosted service, matched by phase text
    r"|Creating (Jcode|Honey) session|Installing (Jcode|Honey) on"  # remote progress phases
)
# A literal passed straight to a path constructor is a file or folder name.
PATH_CALL = re.compile(r"(\.join|PathBuf::from|Path::new)\(\s*$")

# Bundled applets are Python; their only on-screen "Jcode" is this button.
APPLET_LABELS = ("Ask {}",)


def string_spans(src):
    """(start, end) of every ordinary or raw string literal, skipping
    comments, char literals and lifetimes."""
    i, n = 0, len(src)
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if src.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif src.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif (m := re.compile(r'b?r(#*)"').match(src, i)) and (
            i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_")
        ):
            end = src.find('"' + m.group(1), m.end())
            yield i, end + 1 + len(m.group(1))
            i = end + 1 + len(m.group(1))
        elif src[i] == '"':
            j = i + 1
            while src[j] != '"':
                j += 2 if src[j] == "\\" else 1
            yield i, j + 1
            i = j + 1
        elif src[i] == "'":
            m = re.compile(r"'(\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'").match(src, i)
            i = m.end() if m else i + 1
        else:
            i += 1


def rewrite(src, old, new):
    out, last, count = [], 0, 0
    word = re.compile(r"\b%s\b" % old)
    for start, end in string_spans(src):
        literal = src[start:end]
        if old not in literal or SKIP.search(literal) or PATH_CALL.search(src[max(0, start - 40):start]):
            continue
        replaced, n = word.subn(new, literal)
        out.append(src[last:start] + replaced)
        last, count = end, count + n
    out.append(src[last:])
    return "".join(out), count


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("apply", "revert"):
        sys.exit(__doc__)
    old, new = ("Jcode", "Honey") if sys.argv[1] == "apply" else ("Honey", "Jcode")
    total = files = 0
    for path in sorted(ROOT.rglob("*.rs")):
        if "target" in path.relative_to(ROOT).parts:
            continue
        src = path.read_text()
        result, count = rewrite(src, old, new)
        if count:
            path.write_text(result)
            total, files = total + count, files + 1
    for path in sorted((ROOT / "applets").rglob("*.py")):
        src = path.read_text()
        result = src
        for label in APPLET_LABELS:
            result = result.replace('"%s"' % label.format(old), '"%s"' % label.format(new))
        if result != src:
            path.write_text(result)
            total, files = total + 1, files + 1
    print(f"{sys.argv[1]}: {total} replacement(s) in {files} file(s)")


if __name__ == "__main__":
    main()
