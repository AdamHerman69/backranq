// Study-only Node preload. The unchanged production Stockfish process is the
// entry point; this hook reports its own CPU rather than guessing from wall time.
const originalSend = process.send?.bind(process);
let sending = false;
function report() {
    if (!originalSend || !process.connected || sending) return;
    sending = true;
    const usage = process.cpuUsage();
    try {
        originalSend({ type: 'study-cpu', cpuSeconds: (usage.user + usage.system) / 1e6,
            maxRssBytes: process.resourceUsage().maxRSS * 1024 }, () => {});
    } catch { /* Parent died; disconnect handler terminates this child. */ }
    sending = false;
}
if (originalSend) process.send = (...args) => { report(); return originalSend(...args); };
setInterval(report, 250).unref();
process.once('SIGTERM', () => { report(); process.exit(0); });
process.once('disconnect', () => process.exit(1));
process.once('exit', report);
