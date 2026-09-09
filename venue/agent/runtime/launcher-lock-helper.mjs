process.stdout.write("LOCK_ACQUIRED\n");
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdin.once("error", () => process.exit(1));
