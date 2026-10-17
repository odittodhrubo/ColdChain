// npm run seed: 3 users, 2 fridges, 2 devices. Passwords and generated secrets are printed once, here only.
import { openDb } from '../db';
import { seed } from '../db/seed';
import { loadEnvOrExit } from '../env';

async function main() {
  const config = loadEnvOrExit();
  const db = openDb(config.DB_PATH);
  const result = await seed(db, config);

  console.log(`Seeded ${config.DB_PATH}\n\nUsers:`);
  for (const u of result.users) {
    console.log(
      `  ${u.role.padEnd(10)} ${u.email.padEnd(28)} ${u.password ? `password: ${u.password}` : '(exists, unchanged)'}`,
    );
  }
  console.log('\nDevices:');
  for (const d of result.devices) {
    if (d.source === 'existing') console.log(`  ${d.deviceId}  (exists, secret unchanged)`);
    else if (d.source === 'env')
      console.log(`  ${d.deviceId}  secret from .env (matches the firmware config.h)`);
    else
      console.log(`  ${d.deviceId}  secret: ${d.secret}   <- put this in firmware config.h DEVICE_SECRETS`);
  }
  console.log('\nStore these now: they are not shown again.');
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
