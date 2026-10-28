import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      JWT_SECRET_KEY: 'test_secret_must_be_at_least_32_characters_long_for_hs256',
      DATABASE_URL: 'postgresql://postgres:evoai_dev_password@localhost:55434/evo_community?schema=projects',
      EVO_AUTH_SERVICE_URL: 'http://localhost:3011',
    },
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
