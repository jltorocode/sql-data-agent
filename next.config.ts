import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The PostgreSQL parser ships a WebAssembly file it loads from its own folder: don't bundle it.
  serverExternalPackages: ['libpg-query'],
};

export default nextConfig;
