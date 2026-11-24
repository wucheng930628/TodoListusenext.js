const taskCreateTestTable = process.env.SLOWLY_PHASE5_B1_TABLE || "";
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the isolated API test server separate from an existing next dev session.
  distDir: /^Slowly_Phase5B1_[a-f0-9]{32}$/.test(taskCreateTestTable) ? `.next-phase5b2-${taskCreateTestTable.slice(-32)}`
    : /^[a-f0-9-]{36}$/.test(process.env.SLOWLY_BROWSER_ACCEPTANCE_RUN_ID || "") ? `.next-browser-${process.env.SLOWLY_BROWSER_ACCEPTANCE_RUN_ID}` : process.env.SLOWLY_MAIN_UI_TEST === "1" ? ".next-main-ui" : process.env.SLOWLY_CONTROLLED_UI_RUN_ID ? ".next-controlled-ui" : process.env.SLOWLY_API_TEST === "1" ? ".next-phase3-api" : ".next",
  /* config options here */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
