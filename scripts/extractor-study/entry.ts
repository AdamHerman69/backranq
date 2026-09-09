import { main } from './cli';
await main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
