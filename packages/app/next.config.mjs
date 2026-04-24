/** @type {import('next').NextConfig} */
const nextConfig = {
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
