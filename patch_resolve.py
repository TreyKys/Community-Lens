import re

with open('packages/app/app/api/markets/resolve/route.ts', 'r') as f:
    content = f.read()

content = content.replace(
    ".select('id, user_id, outcome_index, net_stake_tngn, stake_tngn, is_bonus_bet, bonus_stake_tngn')",
    ".select('id, user_id, outcome_index, net_stake_tngn, stake_tngn, real_stake_tngn, bonus_stake_tngn')"
)

with open('packages/app/app/api/markets/resolve/route.ts', 'w') as f:
    f.write(content)
