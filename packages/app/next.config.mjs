/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone) with only the
  // node_modules actually reachable at runtime. Required for the container
  // image: it turns a ~1GB node_modules install into a ~150MB image and lets
  // the final stage run `node server.js` with no npm install at all.
  // Harmless on any other host — nothing reads it unless we containerise.
  output: 'standalone',
  // Next spawns one build worker per CPU, each with its own V8 heap. On a small
  // instance (2 vCPU / 2 GB) that OOMs and the worker dies with SIGABRT. Set
  // NEXT_BUILD_CPUS=1 in constrained environments to serialise the work; unset
  // everywhere else so normal builds keep full parallelism.
  ...(process.env.NEXT_BUILD_CPUS
    ? { experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS) } }
    : {}),
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'js.paystack.co' },
      { protocol: 'https', hostname: 'play-lh.googleusercontent.com' },
      { protocol: 'https', hostname: 'encrypted-tbn0.gstatic.com' },
      { protocol: 'https', hostname: 'assets.bundesliga.com' },
      { protocol: 'https', hostname: '1000logos.net' },
      { protocol: 'https', hostname: 'ktsportdesign.com' },
      { protocol: 'https', hostname: 'sassets.knvb.nl' },
      { protocol: 'https', hostname: '1000marcas.net' },
    ],
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
