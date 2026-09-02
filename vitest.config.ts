import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/helpers/global-setup.ts'],
    // Database tests share one schema, so parallel files would truncate each
    // other's rows mid-test.
    fileParallelism: false,
  },
});
