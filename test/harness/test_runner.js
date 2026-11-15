function createSuiteRunner(suiteTitle) {
  const tests = [];
  let passed = 0;
  let failed = 0;
  const failures = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  async function run({ silent = false } = {}) {
    if (!silent) {
      console.log(`\n========================================`);
      console.log(suiteTitle);
      console.log(`========================================`);
    }
    for (const t of tests) {
      let settled = false;
      const beforeExitGuard = () => {
        if (!settled) {
          console.error(`  \u2717 ${t.name} -> Test hung with unresolved promise (event loop drained)`);
          process.exitCode = 1;
        }
      };
      process.once('beforeExit', beforeExitGuard);
      try {
        await t.fn();
        settled = true;
        passed++;
        if (!silent) console.log(`  \u2713 ${t.name}`);
      } catch (err) {
        settled = true;
        failed++;
        failures.push({ name: t.name, error: err });
        console.error(`  \u2717 ${t.name}`);
        console.error(`    -> ${err && err.stack ? err.stack : err}`);
      } finally {
        process.removeListener('beforeExit', beforeExitGuard);
      }
    }
    if (!silent) {
      console.log(`----------------------------------------`);
      console.log(`${suiteTitle}: ${passed}/${tests.length} passed`);
    }
    return { total: tests.length, passed, failed, failures };
  }

  return { test, run };
}

module.exports = { createSuiteRunner };
