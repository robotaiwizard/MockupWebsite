// Create or reset an admin account:  npm run create-admin -- you@example.com "Your Name"
// The password is typed in (not shown) so it never ends up in shell history.
const readline = require('readline');
const { db, now, migrate } = require('../src/db');
const { hashPassword, destroyAllSessions } = require('../src/auth');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : '');
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email || !/@/.test(email)) {
    console.error('Usage: npm run create-admin -- <email> "<name>"');
    process.exit(1);
  }
  const password = process.env.ADMIN_PASSWORD || (await askHidden('Password (min 12 characters): '));
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  await migrate();
  const row = { name: nameParts.join(' ') || email.split('@')[0], password_hash: await hashPassword(password), active: true };
  const existing = await db('admins').where({ email: email.toLowerCase() }).first();
  if (existing) {
    await db('admins').where({ id: existing.id }).update(row);
    await destroyAllSessions('admin', existing.id);
    console.log(`Updated admin ${email} (password reset, signed out everywhere).`);
  } else {
    await db('admins').insert({ email: email.toLowerCase(), created_at: now(), ...row });
    console.log(`Created admin ${email}.`);
  }
  await db.destroy();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
