import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node count.mjs <file>');
  process.exitCode = 1;
} else {
  try {
    const bytes = readFileSync(args[0]);
    console.log(bytes.length);
  } catch (error) {
    console.error(`Cannot read file: ${error.message}`);
    process.exitCode = 1;
  }
}
