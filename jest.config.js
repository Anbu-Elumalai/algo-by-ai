module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/tests/**/*.test.ts"],
  setupFilesAfterEnv: [],
  forceExit: true,
  clearMocks: true,
  restoreMocks: true,
};
