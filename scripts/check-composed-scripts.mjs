// Syntax-check the composed inline interceptor scripts in dist/content.js.
// The inline extractor scripts and the generic wrapper are raw JS inside
// backtick templates: any unescaped quote/backslash in them produces a
// composed <script> that fails to parse at runtime, so they are evaluated
// and parse-checked here before the build can succeed.
import fs from "node:fs";
import vm from "node:vm";

const dist = new URL("../dist/content.js", import.meta.url);
const src = fs.readFileSync(dist, "utf8");

function extractTemplate(startIdx) {
  for (let i = startIdx + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") return { end: i, raw: src.slice(startIdx, i + 1) };
    if (c === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      let q = null;
      for (; i < src.length; i++) {
        const d = src[i];
        if (q) {
          if (d === "\\") i++;
          else if (d === q) q = null;
          continue;
        }
        if (d === "'" || d === '"' || d === "`") { q = d; continue; }
        if (d === "$" && src[i + 1] === "{") { depth++; i++; continue; }
        if (d === "}") { depth--; if (depth === 0) break; }
      }
      continue;
    }
  }
  throw new Error(`no matching backtick at offset ${startIdx}`);
}

const failures = [];
function check(name, code) {
  try {
    new vm.Script(code, { filename: name });
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

// Generic wrapper: template inside injectApiInterceptor()
const iaIdx = src.indexOf("function injectApiInterceptor");
if (iaIdx < 0) throw new Error("injectApiInterceptor not found in dist/content.js");
const wrapperTpl = extractTemplate(src.indexOf("`", iaIdx)).raw;

// Site scripts: template in each class's getInjectedScript()
const classMatches = [...src.matchAll(/var (\w+) = class[^{]*\{/g)].map((m) => ({
  name: m[1],
  start: m.index,
}));
let checked = 0;
for (let k = 0; k < classMatches.length; k++) {
  const { name, start } = classMatches[k];
  const end = k + 1 < classMatches.length ? classMatches[k + 1].start : src.length;
  const gIdx = src.indexOf("getInjectedScript", start);
  if (gIdx < 0 || gIdx >= end) continue;
  const bt = src.indexOf("`", gIdx);
  if (bt < 0 || bt > gIdx + 400) continue;
  const site = eval(extractTemplate(bt).raw);
  const wrapper = wrapperTpl.replace("${siteScripts}", () => site);
  check(`${name} (inline)`, site);
  check(`${name} (composed)`, wrapper);
  checked++;
}

for (const f of failures) console.error(`[composed-scripts] FAIL ${f}`);
if (failures.length > 0) {
  process.exit(1);
}
console.log(`[composed-scripts] ${checked} inline scripts parse OK (inline + composed)`);
