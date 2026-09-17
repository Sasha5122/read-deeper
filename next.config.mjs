/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["pdf-parse", "mammoth"],
  // Cloud Run: self-contained server bundle copied into the Docker image.
  output: "standalone",
};

export default nextConfig;
