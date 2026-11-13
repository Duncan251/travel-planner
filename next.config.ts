import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These routes read files at run time (Katie's and the support assistant's prompts, and
  // the help articles). Make sure Vercel packages those folders with them.
  outputFileTracingIncludes: {
    "/api/chat": ["./prompts/**/*"],
    "/api/support": ["./prompts/**/*", "./knowledge/**/*.md"],
  },
};

export default nextConfig;
