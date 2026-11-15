const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  // 1. Run static & architectural test suite + smoke test as separate subprocesses (so process.exit in those scripts doesn't abort)
  for (const script of ['test/run_tests.js', 'test/runtime_smoke.js']) {
    const res = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
    if (res.status !== 0) process.exit(res.status || 1);
  }

  // 2. Run all full runtime suites in-process so V8 coverage aggregates cleanly
  const suites = [
    require('./suites/background_full.test'),
    require('./suites/popup_full.test'),
    require('./suites/options_full.test'),
    require('./suites/welcome_full.test'),
    require('./suites/integration_full.test')
  ];

  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const r = await s.run();
    total += r.total;
    passed += r.passed;
    failed += r.failed;
  }

  console.log('\n========================================');
  console.log(`ALL RUNTIME SUITES: ${passed}/${total} PASSED`);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
