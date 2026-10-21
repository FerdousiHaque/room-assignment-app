// Usage: npm run hash-password -- "YourChosenPassword"
import { createHash } from 'node:crypto';
const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash-password -- "YourChosenPassword"');
  process.exit(1);
}
console.log(createHash('sha256').update(pw).digest('hex'));
