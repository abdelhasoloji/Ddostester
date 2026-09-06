import { hashPassword } from '../dist/auth/passwords.js';
const pw = process.argv[2];
if (!pw) {
  console.error('Usage: node scripts/hash-password.mjs <password>');
  process.exit(1);
}
console.log(hashPassword(pw));
