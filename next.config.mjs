/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the isolated API test server separate from an existing next dev session.
  distDir: process.env.SLOWLY_API_TEST === "1" ? ".next-phase3-api" : ".next",
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
