#!/usr/bin/env node
// parity-compare: compare two screenshots, or two directories of them, and report what differs.
//
//   parity-compare --a <dir|png> --b <dir|png> [--out results.json] [options]
//
// Exit codes: 0 nothing failed, 1 at least one screen failed, 2 a usage or input error.

import fs from "node:fs";
import path from "node:path";
import { readPng, PngError } from "./png.mjs";
import { compareScreens, DEFAULTS, VERSION } from "./compare.mjs";

export class UsageError extends Error {}

export function parseArgs(argv) {
  const args = {
    a: null, b: null, out: null, masks: null, json: false,
    colourTolerance: DEFAULTS.colourTolerance,
    contentThreshold: DEFAULTS.contentThreshold,
    offsetTolerance: DEFAULTS.offsetTolerance,
    antialiasRadius: DEFAULTS.antialiasRadius,
  };
  const numbers = new Set(["colourTolerance", "contentThreshold", "offsetTolerance", "antialiasRadius"]);
  const alias = {
    "--a": "a", "--b": "b", "--out": "out", "--masks": "masks",
    "--colour-tolerance": "colourTolerance", "--color-tolerance": "colourTolerance",
    "--content-threshold": "contentThreshold", "--offset-tolerance": "offsetTolerance",
    "--antialias-radius": "antialiasRadius",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { args.json = true; continue; }
    if (flag === "--version") { args.version = true; continue; }
    if (flag === "--help" || flag === "-h") { args.help = true; continue; }
    const key = alias[flag];
    if (!key) throw new UsageError(`unknown option ${flag}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (numbers.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a number of 0 or more`);
      args[key] = n;
    } else args[key] = value;
  }
  if (args.help || args.version) return args;
  if (!args.a || !args.b) throw new UsageError("both --a and --b are required");
  return args;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const pngsIn = (dir) => fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();

/** The screens to compare: every PNG name that appears in either side. */
export function pairScreens(a, b) {
  if (!isDir(a) && !isDir(b)) return [{ name: path.basename(a, ".png"), a, b }];
  if (!isDir(a) || !isDir(b)) throw new UsageError("--a and --b must both be files or both be directories");
  const names = [...new Set([...pngsIn(a), ...pngsIn(b)])].sort();
  return names.map((n) => ({
    name: n.replace(/\.png$/i, ""),
    a: fs.existsSync(path.join(a, n)) ? path.join(a, n) : null,
    b: fs.existsSync(path.join(b, n)) ? path.join(b, n) : null,
  }));
}

/** Masks are fractions of the image, so one file fits any scale factor. */
export function masksFor(spec, name, width, height) {
  const list = spec?.[name] ?? [];
  return list.map((m) => ({
    x0: Math.round(m.x * width), y0: Math.round(m.y * height),
    x1: Math.round((m.x + m.w) * width), y1: Math.round((m.y + m.h) * height),
    reason: m.reason ?? null,
  }));
}

function line(name, r) {
  if (r.error) return `  ${name.padEnd(22)} ERROR  ${r.error}`;
  const offset = r.position.maxOffset ? `${r.position.maxOffset}px` : "-";
  return [
    `  ${name.padEnd(22)}`,
    r.verdict.toUpperCase().padEnd(6),
    `bands ${String(r.structure.matched)}/${String(r.structure.rnBands)}`.padEnd(12),
    `offset ${offset}`.padEnd(13),
    `content ${(r.content.overallRatio * 100).toFixed(2)}%`.padEnd(15),
    `worst band ${(r.content.worstBandRatio * 100).toFixed(2)}%`,
  ].join(" ");
}

export function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    err.write(`${e.message}\n`); return 2;
  }
  if (args.version) { out.write(`parity-compare ${VERSION}\n`); return 0; }
  if (args.help) {
    out.write("parity-compare --a <dir|png> --b <dir|png> [--out results.json] [--masks masks.json]\n");
    return 0;
  }

  let maskSpec = null;
  if (args.masks) {
    try { maskSpec = JSON.parse(fs.readFileSync(args.masks, "utf8")); } catch (e) {
      err.write(`cannot read --masks ${args.masks}: ${e.message}\n`); return 2;
    }
  }

  let screens;
  try { screens = pairScreens(args.a, args.b); } catch (e) {
    err.write(`${e.message}\n`); return 2;
  }
  if (!screens.length) { err.write("no PNGs to compare\n"); return 2; }

  const results = {};
  for (const s of screens) {
    if (!s.a || !s.b) {
      results[s.name] = { verdict: "fail", error: s.a ? "missing on the B side" : "missing on the A side" };
      continue;
    }
    try {
      const a = readPng(s.a);
      const b = readPng(s.b);
      results[s.name] = compareScreens(a, b, {
        masks: masksFor(maskSpec, s.name, a.width, a.height),
        colourTolerance: args.colourTolerance,
        contentThreshold: args.contentThreshold,
        offsetTolerance: args.offsetTolerance,
        antialiasRadius: args.antialiasRadius,
      });
    } catch (e) {
      results[s.name] = { verdict: "fail", error: e instanceof PngError ? e.message : String(e.message ?? e) };
    }
  }

  const summary = { pass: 0, drift: 0, fail: 0 };
  for (const r of Object.values(results)) summary[r.verdict]++;
  const report = { tool: { name: "parity-compare", version: VERSION }, createdAt: new Date().toISOString(), summary, screens: results };

  if (args.json) out.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const [name, r] of Object.entries(results)) out.write(`${line(name, r)}\n`);
    out.write(`  ${summary.pass} pass, ${summary.drift} drift, ${summary.fail} fail\n`);
  }
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  return summary.fail > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
