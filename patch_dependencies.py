import json

with open('packages/app/package.json', 'r') as f:
    data = json.load(f)

# The issue might be next being listed in dependencies and missing some underlying stuff,
# or @netlify/plugin-nextjs causing issues if not configured or if it's the wrong version for next 14.
# Wait, @netlify/plugin-nextjs is deprecated for Next 14+ on Netlify since they have native next runtimes.
# Let's remove @netlify/plugin-nextjs

if '@netlify/plugin-nextjs' in data.get('dependencies', {}):
    del data['dependencies']['@netlify/plugin-nextjs']

with open('packages/app/package.json', 'w') as f:
    json.dump(data, f, indent=2)
