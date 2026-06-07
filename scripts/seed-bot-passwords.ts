/**
 * Seed passwords for bot accounts (bot1@odds.ng - bot20@odds.ng)
 *
 * Usage:
 *   npx ts-node scripts/seed-bot-passwords.ts
 *
 * Make sure SUPABASE_SERVICE_ROLE_KEY env var is set.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function seedBotPasswords() {
  const botPassword = 'OddsBot@2024!SecurePass'; // Shared password for all bots
  const botEmails = Array.from({ length: 20 }, (_, i) => `bot${i + 1}@odds.ng`);

  console.log(`Setting passwords for ${botEmails.length} bot accounts...\n`);

  for (const email of botEmails) {
    try {
      // Get user by email
      const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();

      if (listError) {
        console.error(`❌ Error listing users:`, listError);
        continue;
      }

      const user = users?.find(u => u.email === email);

      if (!user) {
        console.log(`⚠️  ${email}: User not found (will be created on first signup attempt)`);
        continue;
      }

      // Update password
      const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
        password: botPassword,
      });

      if (updateError) {
        console.error(`❌ ${email}: ${updateError.message}`);
      } else {
        console.log(`✅ ${email}: Password set successfully`);
      }
    } catch (err: any) {
      console.error(`❌ ${email}: ${err.message}`);
    }
  }

  console.log(`\n✨ Bot password seeding complete!`);
  console.log(`\nBot login credentials:`);
  console.log(`Email: bot1@odds.ng (through bot20@odds.ng)`);
  console.log(`Password: ${botPassword}`);
  console.log(`\nBots can now log in via password in the AuthModal.`);
}

seedBotPasswords().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
