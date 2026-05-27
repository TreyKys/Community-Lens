import re

with open('packages/app/app/api/cron/swarm-tick/route.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "import { isAdminRequest } from '@/lib/adminAuth';",
    ""
)

content = "import { isAdminRequest } from '@/lib/adminAuth';\n" + content

with open('packages/app/app/api/cron/swarm-tick/route.ts', 'w') as f:
    f.write(content)
