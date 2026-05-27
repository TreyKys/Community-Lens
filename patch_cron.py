import re

with open('packages/app/app/api/cron/swarm-tick/route.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "const isValidCron = cronSecret === process.env.CRON_SECRET;\n    \n    // We allow an override via a query param for testing in development\n    const url = new URL(request.url);\n    const isDevOverride = url.searchParams.get('dev') === 'true';\n\n    if (!isValidCron && !isDevOverride) {",
    "import { isAdminRequest } from '@/lib/adminAuth';\n\n    const isValidCron = cronSecret === process.env.CRON_SECRET;\n    const isValidAdmin = isAdminRequest(request);\n\n    if (!isValidCron && !isValidAdmin) {"
)

with open('packages/app/app/api/cron/swarm-tick/route.ts', 'w') as f:
    f.write(content)
