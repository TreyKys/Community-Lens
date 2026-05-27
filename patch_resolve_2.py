import re

with open('packages/app/app/api/markets/resolve/route.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "const real = b.real_stake_tngn !== undefined ? b.real_stake_tngn : b.net_stake_tngn;\n        const promo = b.bonus_stake_tngn !== undefined ? b.bonus_stake_tngn : 0;",
    "const real = b.real_stake_tngn != null ? b.real_stake_tngn : b.net_stake_tngn;\n        const promo = b.bonus_stake_tngn != null ? b.bonus_stake_tngn : 0;"
)

with open('packages/app/app/api/markets/resolve/route.ts', 'w') as f:
    f.write(content)
