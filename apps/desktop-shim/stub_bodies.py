#!/usr/bin/env python3
"""Replace every function body in a Rust file with `todo!()`, keeping signatures.

Used once, for Phase 2 of docs/specs/2026-10-26-jcode-sdk-shim-contract.md:
it turns a copy of jcode-sdk's client/launch/ssh/auth modules into stubs whose
public surface is identical to upstream by construction. Bodies inside
`impl <Trait> for <Type>` blocks are kept verbatim (Drop/Default/Clone/Iterator
would otherwise panic or change behaviour), as are `const fn`s.

Usage: stub_bodies.py <file.rs>   (rewrites in place)
"""

import re
import sys


def scan(src):
    """Yield (index, char) for code chars only: skips comments, strings, chars."""
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if src.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif src.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            continue
        m = re.compile(r'b?r(#*)"').match(src, i)
        if m and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_")):
            end = '"' + m.group(1)
            j = src.find(end, m.end())
            i = j + len(end)
            continue
        if c == '"' or (c == "b" and src.startswith('b"', i)):
            i += 2 if c == "b" else 1
            while src[i] != '"':
                i += 2 if src[i] == "\\" else 1
            i += 1
            continue
        if c == "'":
            # char literal ('a', '\n', '\u{1F600}') vs lifetime ('a)
            m = re.compile(r"'(\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'").match(src, i)
            if m:
                i = m.end()
                continue
        yield i, c
        i += 1


def match_brace(src, open_idx):
    depth = 0
    for i, c in scan(src[open_idx:]):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return open_idx + i
    raise ValueError("unbalanced braces")


FN_RE = re.compile(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)")
TRAIT_IMPL_RE = re.compile(r"\bimpl\b[^{;]*\bfor\b[^{;]*$", re.S)


def stub(src):
    code = dict(scan(src))  # index -> char, code positions only
    out, i = [], 0
    trait_impl_ranges = []
    for m in re.finditer(r"\bimpl\b", src):
        if m.start() not in code:
            continue
        brace = src.find("{", m.end())
        header = src[m.start():brace]
        if ";" in header:
            continue
        if TRAIT_IMPL_RE.search(header):
            trait_impl_ranges.append((brace, match_brace(src, brace)))

    def in_trait_impl(pos):
        return any(a < pos < b for a, b in trait_impl_ranges)

    for m in FN_RE.finditer(src):
        if m.start() < i or m.start() not in code or in_trait_impl(m.start()):
            continue
        if re.search(r"\bconst\s+(unsafe\s+)?$", src[max(0, m.start() - 20):m.start()]):
            continue
        # find the body's opening brace, or a `;` (trait method declaration)
        depth, body = 0, None
        for j, c in scan(src[m.end():]):
            j += m.end()
            if c in "(<[":
                depth += 1
            elif c in ")>]":
                depth -= 1 if not (c == ">" and src[j - 1] == "-") else 0
            elif c == ";" and depth <= 0:
                break
            elif c == "{" and depth <= 0:
                body = j
                break
        if body is None:
            continue
        end = match_brace(src, body)
        out.append(src[i:body])
        out.append('{\n        todo!("jcode-sdk shim: %s")\n    }' % m.group(1))
        i = end + 1
    out.append(src[i:])
    return "".join(out)


if __name__ == "__main__":
    path = sys.argv[1]
    with open(path) as f:
        text = f.read()
    with open(path, "w") as f:
        f.write(stub(text))
