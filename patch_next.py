import re

with open('packages/app/next.config.mjs', 'r') as f:
    content = f.read()

# Add experimental outputFileTracingRoot to see if it fixes Netlify Vercel runtime issues
if 'experimental:' not in content:
    content = content.replace('};', '  experimental: {\n    outputFileTracingRoot: process.cwd(),\n  },\n};')

with open('packages/app/next.config.mjs', 'w') as f:
    f.write(content)
