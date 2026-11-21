const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET_FILES = [
  'background/background.js',
  'popup/popup.js',
  'options/options.js',
  'options/theme.js',
  'welcome/welcome.js',
  'welcome/land.js'
];

function computeExecMask(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  const n = src.length;
  let state = 'normal';
  let prev = '';
  const rePrevs = new Set(['', '(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '~', '^', '+', '-', '*', '%', '<', '>', '\n']);

  while (i < n) {
    const ch = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    if (state === 'normal') {
      if (ch === '/' && nxt === '/') { state = 'sl'; i += 2; continue; }
      if (ch === '/' && nxt === '*') { state = 'ml'; i += 2; continue; }
      if (ch === "'") { state = 'sq'; mask[i] = 1; prev = "'"; i++; continue; }
      if (ch === '"') { state = 'dq'; mask[i] = 1; prev = '"'; i++; continue; }
      if (ch === '`') { state = 'bt'; mask[i] = 1; prev = '`'; i++; continue; }
      if (ch === '/' && rePrevs.has(prev)) {
        let j = i + 1, esc = false, cls = false, isRe = false;
        while (j < n && src[j] !== '\n') {
          const c2 = src[j];
          if (esc) esc = false;
          else if (c2 === '\\') esc = true;
          else if (c2 === '[') cls = true;
          else if (c2 === ']') cls = false;
          else if (c2 === '/' && !cls) { isRe = true; break; }
          j++;
        }
        if (isRe) {
          for (let k = i; k <= j; k++) mask[k] = 1;
          i = j + 1; prev = 're'; continue;
        }
      }
      if (!/\s/.test(ch)) {
        mask[i] = 1;
        prev = ch;
      }
      i++;
    } else if (state === 'sl') {
      if (ch === '\n') state = 'normal';
      i++;
    } else if (state === 'ml') {
      if (ch === '*' && nxt === '/') { state = 'normal'; i += 2; }
      else i++;
    } else {
      const q = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
      mask[i] = 1;
      if (ch === '\\') {
        if (i + 1 < n) mask[i + 1] = 1;
        i += 2;
      } else if (ch === q) {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    }
  }
  return mask;
}

function analyzeCoverage(covDir, files = TARGET_FILES) {
  const fileInfo = {};
  for (const tf of files) {
    const abs = path.join(ROOT, tf);
    const src = fs.readFileSync(abs, 'utf8');
    const lines = src.split('\n');
    const lineSpans = [];
    let cur = 0;
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      lineSpans.push({ ln: idx + 1, start: cur, end: cur + l.length, text: l });
      cur += l.length + 1;
    }
    fileInfo[tf] = {
      rel: tf,
      abs,
      src,
      len: src.length,
      mask: computeExecMask(src),
      counts: new Uint32Array(src.length),
      fnSeen: new Map(),
      rangeSeen: new Map(),
      lineSpans
    };
  }

  for (const fname of fs.readdirSync(covDir)) {
    if (!fname.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(covDir, fname), 'utf8'));
    for (const script of (data.result || [])) {
      const url = script.url || '';
      const normUrl = url.replace(/\\/g, '/');
      const info = files.map(tf => fileInfo[tf]).find(f => {
        const normAbs = f.abs.replace(/\\/g, '/');
        return normUrl.endsWith('/' + f.rel) || normUrl === 'file://' + normAbs || normUrl === 'file:///' + normAbs || normUrl === normAbs;
      });
      if (!info) continue;
      const sc = new Uint32Array(info.len);
      for (const fn of (script.functions || [])) {
        const ranges = fn.ranges || [];
        if (!ranges.length) continue;
        const outer = ranges[0];
        const fKey = `${outer.startOffset}:${outer.endOffset}:${fn.functionName || ''}`;
        info.fnSeen.set(fKey, Math.max(info.fnSeen.get(fKey) || 0, outer.count));
        const sorted = [...ranges].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
        for (const r of sorted) {
          const s = Math.max(0, r.startOffset);
          const e = Math.min(info.len, r.endOffset);
          for (let p = s; p < e; p++) sc[p] = r.count;
          if (fn.isBlockCoverage) {
            const rKey = `${s}:${e}`;
            info.rangeSeen.set(rKey, Math.max(info.rangeSeen.get(rKey) || 0, r.count));
          }
        }
      }
      for (let p = 0; p < info.len; p++) info.counts[p] += sc[p];
    }
  }

  const summary = [];
  let totalExec = 0, totalCov = 0;
  let totalFns = 0, totalFnsCov = 0;
  let totalBlocks = 0, totalBlocksCov = 0;

  for (const tf of files) {
    const info = fileInfo[tf];
    let execLines = 0, covLines = 0;
    const uncovered = [];
    for (const { ln, start, end, text } of info.lineSpans) {
      const st = text.trim();
      const idxs = [];
      for (let p = start; p < end; p++) if (info.mask[p]) idxs.push(p);
      if (!idxs.length || ['{', '}', '});', '};', ']);', ');', 'else {', '} else {'].includes(st)) continue;
      execLines++;
      if (idxs.some(p => info.counts[p] > 0)) covLines++;
      else uncovered.push({ ln, text: st });
    }
    const fnTotal = info.fnSeen.size;
    const fnCov = Array.from(info.fnSeen.values()).filter(v => v > 0).length;
    const blkTotal = info.rangeSeen.size;
    const blkCov = Array.from(info.rangeSeen.values()).filter(v => v > 0).length;
    totalExec += execLines; totalCov += covLines;
    totalFns += fnTotal; totalFnsCov += fnCov;
    totalBlocks += blkTotal; totalBlocksCov += blkCov;
    summary.push({
      file: tf,
      execLines, covLines, linePct: execLines ? (100 * covLines / execLines) : 0,
      fnTotal, fnCov, fnPct: fnTotal ? (100 * fnCov / fnTotal) : 0,
      blkTotal, blkCov, blkPct: blkTotal ? (100 * blkCov / blkTotal) : 0,
      uncovered
    });
  }

  return {
    files: summary,
    totalExec,
    totalCov,
    totalLinePct: totalExec ? (100 * totalCov / totalExec) : 0,
    totalFns,
    totalFnsCov,
    totalFnPct: totalFns ? (100 * totalFnsCov / totalFns) : 0,
    totalBlocks,
    totalBlocksCov,
    totalBlockPct: totalBlocks ? (100 * totalBlocksCov / totalBlocks) : 0
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const entry = args[0] || path.join(__dirname, 'run_all.js');
  const threshold = Number(process.env.COV_THRESHOLD || 98);
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leakhalo-v8cov-'));
  try {
    const res = spawnSync(process.execPath, [entry], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_V8_COVERAGE: covDir }
    });
    if (res.status !== 0) process.exit(res.status || 1);
    const report = analyzeCoverage(covDir);
    console.log('\n================================================================================');
    console.log('V8 CODE COVERAGE SUMMARY');
    console.log('================================================================================');
    for (const f of report.files) {
      console.log(
        `${f.file.padEnd(28)} | Lines: ${String(f.covLines).padStart(4)}/${String(f.execLines).padEnd(4)} (${f.linePct.toFixed(2).padStart(6)}%) | ` +
        `Funcs: ${String(f.fnCov).padStart(3)}/${String(f.fnTotal).padEnd(3)} (${f.fnPct.toFixed(2).padStart(6)}%) | ` +
        `Blocks: ${String(f.blkCov).padStart(4)}/${String(f.blkTotal).padEnd(4)} (${f.blkPct.toFixed(2).padStart(6)}%)`
      );
      if (f.uncovered.length) {
        console.log(`   Uncovered (${f.uncovered.length}): ${f.uncovered.map(u => `L${u.ln}`).join(', ')}`);
      }
    }
    console.log('--------------------------------------------------------------------------------');
    console.log(
      `${'TOTAL'.padEnd(28)} | Lines: ${String(report.totalCov).padStart(4)}/${String(report.totalExec).padEnd(4)} (${report.totalLinePct.toFixed(2).padStart(6)}%) | ` +
      `Funcs: ${String(report.totalFnsCov).padStart(3)}/${String(report.totalFns).padEnd(3)} (${report.totalFnPct.toFixed(2).padStart(6)}%) | ` +
      `Blocks: ${String(report.totalBlocksCov).padStart(4)}/${String(report.totalBlocks).padEnd(4)} (${report.totalBlockPct.toFixed(2).padStart(6)}%)`
    );
    console.log('================================================================================\n');
    if (report.totalLinePct < threshold) {
      console.error(`Coverage ${report.totalLinePct.toFixed(2)}% is below threshold ${threshold}%`);
      process.exit(1);
    }
  } finally {
    fs.rmSync(covDir, { recursive: true, force: true });
  }
}

module.exports = { analyzeCoverage, TARGET_FILES };
