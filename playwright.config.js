const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
      args: ['--no-sandbox'],
    } : {},
    trace: 'retain-on-failure',
  },
});
